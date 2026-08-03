// Sauvegarde d'une base de données vers un stockage compatible S3.
//
// Le dumper n'est PAS installé sur la cible : il est déjà dans le conteneur
// qu'on sauvegarde. `pg_dump` vient de `postgres:17-alpine`, `redis-cli` de
// `redis:7-alpine` — les images que `database.ts` lance déjà. Deux
// conséquences, toutes deux voulues :
//
//   · rien à provisionner en face, ce qui tient la décision « agentless, SSH
//     only : paste a host and a key, nothing else » ;
//   · le dumper a par construction la version du serveur, alors qu'un binaire
//     posé sur l'hôte dériverait le jour où quelqu'un crée une base en
//     `postgres:18` — et pg_dump refuse net un serveur plus récent que lui.
//
// Les octets remontent par le canal SSH jusqu'ici, puis repartent vers S3.
// Ils traversent donc le réseau deux fois. C'est assumé : sur la machine
// unique — le cas courant — « deux fois » est du bouclage local, et pousser
// depuis la cible ferait voyager la clé secrète S3 vers chaque serveur, où
// elle apparaîtrait dans un argv.

import type { Readable } from "node:stream";
import {
  type BackupDestination,
  deleteObject,
  objectExists,
  objectSize,
  uploadStream,
} from "@noddle/backup-store";
import { backups } from "@noddle/db/schema";
import { decryptSecret, secretContext } from "@noddle/shared/crypto";
import {
  disconnect,
  execStream,
  quoteArg,
  type SshClient,
} from "@noddle/ssh-executor";
import { eq } from "drizzle-orm";
import { loadDestination } from "#backup-destination";
import { connectTo, type DeployContext } from "#deploy";

type Engine = "postgres" | "redis";

interface DumpSpec {
  /**
   * argv exécuté DANS le conteneur de la base. Rien n'est concaténé à la
   * main : chaque élément est échappé avant d'atteindre le shell distant.
   */
  argv: (opts: { containerId: string; rootUser: string | null }) => string[];
  /**
   * Variables passées à `docker exec -e`. Postgres n'en a aucune — la socket
   * locale du conteneur officiel est en `trust`, donc le mot de passe ne
   * touche JAMAIS une ligne de commande. Redis n'a pas cet échappatoire.
   */
  env: (password: string) => Record<string, string>;
  /** Extension du fichier produit, pour que la clé S3 soit lisible. */
  extension: string;
}

const DUMP_SPECS: Record<Engine, DumpSpec> = {
  postgres: {
    // -Fc : format custom, compressé par zlib À L'INTÉRIEUR de pg_dump. Pas de
    // `| gzip`, donc pas de second processus à faire tenir dans 2 Go, et c'est
    // le format que `pg_restore` attend.
    argv: ({ containerId, rootUser }) => [
      "docker",
      "exec",
      containerId,
      "pg_dump",
      "-Fc",
      "-U",
      rootUser ?? "postgres",
      rootUser ?? "postgres",
    ],
    env: () => ({}),
    extension: "dump",
  },
  redis: {
    // `--rdb -` écrit un RDB sur la sortie standard. Mesuré sur redis:7-alpine :
    // le flux est du RDB pur (magie `REDIS0012`) et tout le bavardage de
    // redis-cli part sur stderr, donc rien ne pollue les octets.
    argv: ({ containerId }) => [
      "docker",
      "exec",
      "-e",
      "REDISCLI_AUTH",
      containerId,
      "redis-cli",
      "--rdb",
      "-",
    ],
    // REDISCLI_AUTH plutôt que `-a <mdp>` : l'option mettrait le mot de passe
    // dans l'argv du `docker` distant, lisible par un `ps` sur cette machine.
    env: (password) => ({ REDISCLI_AUTH: password }),
    extension: "rdb",
  },
};

export function databaseServiceName(name: string): string {
  return `noddle-db-${name}`;
}

/**
 * Retrouve le conteneur qui exécute la task Swarm de cette base.
 *
 * Par le label que Swarm pose lui-même, jamais par le nom du conteneur : ce
 * dernier porte un suffixe de task qui change à chaque redémarrage.
 *
 * Pas de `| grep` ni de `| head` — ces scripts tournent sous `set -o
 * pipefail`, et un consommateur qui sort tôt fait prendre un SIGPIPE au
 * producteur, ce que pipefail transforme en pipeline échoué. C'est une COURSE :
 * le même code passe et échoue une fois sur deux. On découpe ici, en TypeScript.
 */
export async function findDatabaseContainer(
  client: SshClient,
  serviceName: string
): Promise<string> {
  const { code, stderr, value } = await execStream(
    client,
    `docker ps --no-trunc --filter ${quoteArg(`label=com.docker.swarm.service.name=${serviceName}`)} --format ${quoteArg("{{.ID}}")}`,
    async ({ stdout }) => {
      let out = "";
      stdout.setEncoding("utf8");
      for await (const chunk of stdout) {
        out += chunk as string;
      }
      return out;
    }
  );
  if (code !== 0) {
    throw new Error(`docker ps a échoué (code ${code}) : ${stderr}`);
  }
  const id = value
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "");
  if (!id) {
    throw new Error(
      `aucun conteneur en cours pour ${serviceName} — la base tourne-t-elle ?`
    );
  }
  return id;
}

/**
 * Exécute une sauvegarde de bout en bout et met la ligne à jour.
 *
 * Le point de correction du chantier tient en une phrase : **on ne conclut
 * jamais du fait que le flux se soit terminé.** Un `pg_dump` tué à mi-course
 * ferme proprement sa sortie, l'objet se téléverse sans erreur et rien dans
 * les octets ne dit qu'il en manque — mesuré contre RustFS. Seul le code de
 * sortie distingue une sauvegarde d'une moitié de sauvegarde, et une
 * sauvegarde corrompue présentée comme bonne est pire que pas de sauvegarde.
 */
export async function runBackup(
  ctx: DeployContext,
  backupId: string
): Promise<void> {
  const backup = await ctx.db.query.backups.findFirst({
    where: eq(backups.id, backupId),
    with: { database: { with: { server: true } } },
  });
  if (!backup) {
    throw new Error(`sauvegarde introuvable : ${backupId}`);
  }
  const { database } = backup;
  const destination = await loadDestination(ctx);

  const password = decryptSecret(
    database.rootPasswordEncrypted,
    ctx.appKey,
    secretContext.databasePassword(database.id)
  );
  const spec = DUMP_SPECS[database.engine];

  await ctx.db
    .update(backups)
    .set({ startedAt: new Date(), status: "running" })
    .where(eq(backups.id, backupId));

  // La connexion est celle du serveur qui PORTE la base : le volume et le
  // conteneur n'existent que sur ce nœud. Aucun besoin du manager ici — on ne
  // touche pas à la spécification du service, seulement à son conteneur.
  const client = await connectTo(ctx, database.server);

  try {
    const containerId = await findDatabaseContainer(
      client,
      databaseServiceName(database.name)
    );

    const env = spec.env(password);
    const envPrefix = Object.entries(env)
      .map(([k, v]) => `${k}=${quoteArg(v)}`)
      .join(" ");
    const argv = spec
      .argv({ containerId, rootUser: database.rootUser })
      .map(quoteArg)
      .join(" ");
    const command = envPrefix === "" ? argv : `${envPrefix} ${argv}`;

    const { code, stderr } = await execStream(client, command, (io) =>
      uploadStream(destination, backup.objectKey, io.stdout as Readable)
    );

    if (code !== 0) {
      // L'objet est là et il est VALIDE côté S3 : c'est précisément pourquoi
      // il faut le retirer. Le laisser en le marquant `failed` suffirait pour
      // l'interface, mais un compartiment qui contient des demi-dumps finit
      // par servir à quelqu'un qui ne lira pas la colonne statut.
      await deleteObject(destination, backup.objectKey).catch(() => {
        // Un objet orphelin est moins grave que de masquer la vraie cause.
      });
      throw new Error(
        `le dumper est sorti en ${code} — sauvegarde incomplète, objet supprimé : ${stderr.slice(0, 500)}`
      );
    }

    // La taille vient d'un HEAD, pas du compteur d'octets vus passer : ce qui
    // compte est ce que le compartiment détient.
    const sizeBytes = await uploadedSize(destination, backup.objectKey);

    await ctx.db
      .update(backups)
      .set({ finishedAt: new Date(), sizeBytes, status: "completed" })
      .where(eq(backups.id, backupId));
  } catch (err) {
    await ctx.db
      .update(backups)
      .set({
        errorMessage: err instanceof Error ? err.message : String(err),
        finishedAt: new Date(),
        status: "failed",
      })
      .where(eq(backups.id, backupId));
    throw err;
  } finally {
    disconnect(client);
  }
}

/** Relit la taille réelle. Sépare le cas « absent » d'une vraie panne. */
async function uploadedSize(
  destination: BackupDestination,
  key: string
): Promise<number> {
  if (!(await objectExists(destination, key))) {
    throw new Error(
      `le téléversement s'est terminé mais l'objet ${key} est absent du compartiment`
    );
  }
  return await objectSize(destination, key);
}
