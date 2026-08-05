// Restauration d'une base de données depuis une sauvegarde.
//
// C'est la SEULE opération irréversible du produit. Rejouer une image de
// service ne détruit rien — l'image précédente existe toujours, on peut
// repartir en avant. Restaurer écrase des données que rien ne ramène.
//
// Trois conséquences, toutes dans le code et pas seulement dans un texte de
// confirmation :
//
//   · l'objet est vérifié PRÉSENT dans le compartiment avant qu'on touche à
//     quoi que ce soit. La table dit ce que Noddle a écrit ; le compartiment
//     dit ce qui s'y trouve encore. Découvrir l'objet manquant après avoir
//     effacé la base courante serait la pire séquence possible ;
//   · une sauvegarde de sûreté est prise juste avant (`kind='pre_restore'`),
//     ce qui rend l'opération réversible pour de bon ;
//   · seule une sauvegarde `completed` est restaurable — une demi-sauvegarde
//     n'est pas une option qu'on propose.
//
// Les deux moteurs ne se restaurent PAS de la même façon, et la différence
// n'est pas cosmétique : Postgres avale un dump par l'entrée standard d'un
// serveur qui tourne, Redis ne sait pas charger un RDB à chaud.

import { pipeline } from "node:stream/promises";
import {
  backupObjectKey,
  downloadStream,
  objectExists,
} from "@noddle/backup-store";
import { backups } from "@noddle/db/schema";
import type { DockerApi } from "@noddle/ssh-executor";
import {
  disconnect,
  execArgv,
  execStream,
  quoteArg,
  type SshClient,
} from "@noddle/ssh-executor";
import { and, eq } from "drizzle-orm";
import { databaseServiceName, findDatabaseContainer, runBackup } from "#backup";
import { loadDestination } from "#backup-destination";
import { connectForDeploy, type DeployContext } from "#deploy";
import { waitForRunningTask } from "#swarm";

const SETTLE_MS = 1500;
const SCALE_TIMEOUT_MS = 120_000;

export interface RestoreRequest {
  backupId: string;
  databaseId: string;
}

/**
 * Met le nombre de répliques d'un service et attend que ce soit vrai.
 *
 * `docker service update` rend la main AVANT convergence — le même piège que
 * pour un déploiement, et ici il compte double : écrire dans le volume pendant
 * que le conteneur tourne encore corromprait exactement ce qu'on restaure.
 */
async function scaleService(
  docker: DockerApi,
  serviceName: string,
  replicas: number
): Promise<void> {
  const list = await docker.listServices({
    filters: JSON.stringify({ name: [serviceName] }),
  });
  const existing = list.find((s) => s.Spec?.Name === serviceName);
  if (!existing) {
    throw new Error(`Swarm service not found: ${serviceName}`);
  }

  const spec = existing.Spec as Record<string, unknown>;
  await docker.getService(existing.ID as string).update({
    ...spec,
    Mode: { Replicated: { Replicas: replicas } },
    version: existing.Version?.Index,
  });

  if (replicas === 0) {
    const deadline = Date.now() + SCALE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      // biome-ignore lint/performance/noAwaitInLoops: boucle de sondage volontaire
      const tasks = await docker.listTasks({
        filters: JSON.stringify({ service: [serviceName] }),
      });
      const alive = tasks.filter((t) => {
        const state = (t as { Status?: { State?: string } }).Status?.State;
        return (
          state !== "shutdown" && state !== "failed" && state !== "complete"
        );
      });
      if (alive.length === 0) {
        return;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(
      `le service ${serviceName} n'est pas descendu à 0 réplique`
    );
  }
  await waitForRunningTask(docker, serviceName);
}

/**
 * Postgres : `pg_restore` lit l'archive sur son entrée standard, pendant que
 * le serveur tourne. Rien à arrêter.
 *
 * `--exit-on-error` est délibéré. Sans lui, pg_restore continue après une
 * erreur et sort en 0 avec des avertissements : une restauration partielle
 * serait alors indiscernable d'une réussie, ce qui est précisément le défaut
 * qu'on refuse ailleurs pour les déploiements et les sauvegardes.
 * `--clean --if-exists` fait tomber l'existant sans échouer sur ce qui manque.
 */
async function restorePostgres(
  client: SshClient,
  opts: { containerId: string; rootUser: string; body: NodeJS.ReadableStream }
): Promise<void> {
  const argv = [
    "docker",
    "exec",
    "-i",
    opts.containerId,
    "pg_restore",
    "--clean",
    "--if-exists",
    "--exit-on-error",
    "-U",
    opts.rootUser,
    "-d",
    opts.rootUser,
  ];

  const { code, stderr } = await execStream(
    client,
    argv.map(quoteArg).join(" "),
    async ({ stdin, stdout }) => {
      // La sortie standard DOIT être drainée : sans lecteur, la fenêtre du
      // canal se remplit et le processus distant se bloque à l'écriture.
      stdout.resume();
      await pipeline(opts.body, stdin);
    }
  );

  if (code !== 0) {
    throw new Error(
      `pg_restore est sorti en ${code} : ${stderr.slice(0, 800)}`
    );
  }
}

/**
 * Redis : il n'existe aucune commande pour charger un RDB à chaud. Il faut
 * arrêter le service, poser le fichier dans le volume, puis relancer.
 *
 * Et c'est là qu'est le piège, mesuré sur une vraie VM : la base tourne en
 * `--appendonly yes`, donc au démarrage Redis charge l'AOF et IGNORE le RDB.
 * Poser dump.rdb et redémarrer ne fait donc rien du tout — mesuré : la clé
 * ajoutée après la sauvegarde était toujours là. Purger l'AOF ne suffit pas
 * davantage : sans AOF, Redis 7 démarre VIDE et en fabrique un neuf, il ne se
 * rabat jamais sur le RDB. Mesuré aussi, et c'est le pire des deux — une
 * restauration « réussie » qui rend une base vide.
 *
 * D'où le conteneur JETABLE : il monte le même volume, démarre en
 * `--appendonly no` (donc il charge bien le RDB), puis on active l'AOF à
 * chaud, ce qui le fait réécrire depuis les données chargées. Le volume
 * contient alors un AOF qui correspond à la sauvegarde, et le vrai service n'a
 * plus qu'à redémarrer avec ses arguments habituels, inchangés.
 */
async function restoreRedis(
  client: SshClient,
  opts: { body: NodeJS.ReadableStream; volume: string }
): Promise<void> {
  const helper = `noddle-restore-${Date.now()}`;

  // 1. Poser le RDB et purger l'AOF, DEPUIS un conteneur monté sur le volume.
  const writeArgv = [
    "docker",
    "run",
    "--rm",
    "-i",
    "-v",
    `${opts.volume}:/data`,
    "alpine",
    "sh",
    "-c",
    "rm -rf /data/appendonlydir /data/appendonly.aof && cat > /data/dump.rdb",
  ];
  const write = await execStream(
    client,
    writeArgv.map(quoteArg).join(" "),
    async ({ stdin, stdout }) => {
      stdout.resume();
      await pipeline(opts.body, stdin);
    }
  );
  if (write.code !== 0) {
    throw new Error(
      `écriture du RDB dans le volume échouée (code ${write.code}) : ${write.stderr.slice(0, 500)}`
    );
  }

  // 2. Le conteneur jetable convertit le RDB en AOF.
  const convert = await execArgv(client, [
    "sh",
    "-c",
    [
      `docker run -d --name ${helper} -v ${opts.volume}:/data redis:7-alpine`,
      "redis-server --appendonly no --dir /data --dbfilename dump.rdb >/dev/null",
      "&& sleep 3",
      `&& docker exec ${helper} redis-cli CONFIG SET appendonly yes >/dev/null`,
      "&& for i in $(seq 1 30); do",
      `  s=$(docker exec ${helper} redis-cli INFO persistence | tr -d '\\r' | sed -n 's/^aof_rewrite_in_progress://p');`,
      '  [ "$s" = "0" ] && break; sleep 1;',
      "done",
      `&& docker exec ${helper} redis-cli SHUTDOWN NOSAVE >/dev/null 2>&1 || true`,
    ].join(" "),
  ]);

  // Le conteneur jetable est retiré quoi qu'il arrive : en laisser un derrière
  // bloquerait la restauration suivante sur un nom déjà pris.
  await execArgv(client, ["docker", "rm", "-f", helper]);

  if (convert.code !== 0) {
    throw new Error(
      `conversion RDB→AOF échouée (code ${convert.code}) : ${convert.stderr.slice(0, 500)}`
    );
  }
}

export async function runRestore(
  ctx: DeployContext,
  req: RestoreRequest
): Promise<void> {
  const backup = await ctx.db.query.backups.findFirst({
    where: and(
      eq(backups.id, req.backupId),
      eq(backups.databaseId, req.databaseId)
    ),
    with: { database: { with: { server: true } } },
  });
  if (!backup) {
    throw new Error(
      "sauvegarde introuvable pour cette base — restauration croisée refusée"
    );
  }
  if (backup.status !== "completed") {
    throw new Error(
      `sauvegarde en statut « ${backup.status} » : seule une sauvegarde complète est restaurable`
    );
  }

  const { database } = backup;
  const destination = await loadDestination(ctx);

  // AVANT toute action destructrice. La ligne en base n'est pas une preuve que
  // l'objet est encore là.
  if (!(await objectExists(destination, backup.objectKey))) {
    throw new Error(
      `l'objet ${backup.objectKey} est absent du compartiment — restauration refusée avant d'avoir touché à la base`
    );
  }

  // Le filet : la restauration devient réversible.
  const [safety] = await ctx.db
    .insert(backups)
    .values({
      databaseId: database.id,
      kind: "pre_restore",
      objectKey: backupObjectKey({
        backupId: crypto.randomUUID(),
        databaseName: database.name,
        extension: database.engine === "postgres" ? "dump" : "rdb",
        prefix: destination.prefix,
        takenAt: new Date(),
      }),
    })
    .returning();
  if (!safety) {
    throw new Error("could not create the safety backup");
  }
  await runBackup(ctx, safety.id);

  const serviceName = databaseServiceName(database.name);
  const { buildClient, managerClient } = await connectForDeploy(
    ctx,
    database.server
  );

  try {
    const body = await downloadStream(destination, backup.objectKey);

    if (database.engine === "postgres") {
      const containerId = await findDatabaseContainer(buildClient, serviceName);
      await restorePostgres(buildClient, {
        body,
        containerId,
        rootUser: database.rootUser ?? "postgres",
      });
    } else {
      // Les commandes Swarm passent par le MANAGER — un worker refuse
      // `docker service update`, il ne détient pas l'état du cluster. Le
      // volume, lui, n'existe que sur le nœud de la base.
      const { dockerClient } = await import("@noddle/ssh-executor");
      const managerDocker = dockerClient(managerClient);

      await scaleService(managerDocker, serviceName, 0);
      // Swarm rend la main dès que la task est marquée arrêtée ; laisser
      // quelques instants au démon pour libérer réellement le volume.
      await new Promise((r) => setTimeout(r, SETTLE_MS));

      await restoreRedis(buildClient, { body, volume: serviceName });

      await scaleService(managerDocker, serviceName, 1);
    }
  } finally {
    if (managerClient !== buildClient) {
      disconnect(managerClient);
    }
    disconnect(buildClient);
  }
}
