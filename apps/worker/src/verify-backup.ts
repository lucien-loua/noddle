// Sauvegarde d'une base de données, contre du RÉEL de bout en bout :
// une vraie VM, un vrai Postgres provisionné par Noddle, un vrai RustFS.
//
//   STACK_HOST=192.168.252.3 node apps/worker/src/verify-backup.ts
//
// Le compartiment doit exister au préalable — Noddle n'en crée jamais, c'est
// une ressource que l'utilisateur possède. `packages/backup-store/src/verify.ts`
// crée `noddle-verify` au passage.
//
// La question qui compte n'est pas « le job se termine-t-il ? » mais :
//
//   1. la sauvegarde contient-elle vraiment les données ? (prouvé en
//      commit 6, par une restauration qui les relit)
//   2. une sauvegarde INCOMPLÈTE est-elle refusée ?
//
// Le point 2 est le cœur du chantier. Un dumper tué à mi-course ferme
// proprement son flux : l'objet se téléverse sans erreur et rien dans les
// octets ne dit qu'il en manque. Une sauvegarde corrompue présentée comme
// bonne est pire que pas de sauvegarde du tout.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type BackupDestination,
  backupObjectKey,
  checkDestination,
  objectExists,
} from "@noddle/backup-store";
import { createDatabase } from "@noddle/db";
import {
  backupDestinations,
  backups,
  databases,
  environments,
  projects,
  servers,
} from "@noddle/db/schema";
import { encryptSecret, secretContext } from "@noddle/shared/crypto";
import {
  connect,
  disconnect,
  dockerClient,
  execArgv,
} from "@noddle/ssh-executor";
import { eq, inArray } from "drizzle-orm";
import { databaseServiceName, findDatabaseContainer, runBackup } from "#backup";
import { provisionDatabase } from "#database";
import { removeService } from "#swarm";

const DB_URL =
  process.env.DATABASE_URL ??
  "postgres://postgres:noddle@localhost:55432/noddle";
const HOST = process.env.STACK_HOST ?? "192.168.252.3";
const USER = process.env.TARGET_USER ?? "ubuntu";
const KEY = process.env.SSH_KEY ?? join(homedir(), ".ssh", "id_ed25519");

// RustFS tourne sur la machine de dev ; la VM doit pouvoir l'atteindre, donc
// c'est le worker (ici) qui parle à S3, jamais la cible — ce qui est
// exactement la topologie retenue.
const S3_ENDPOINT = process.env.S3_ENDPOINT ?? "http://localhost:9000";
const S3_KEY = process.env.S3_ACCESS_KEY ?? "rustfsadmin";
const S3_SECRET = process.env.S3_SECRET_KEY ?? "rustfsadmin";
const S3_BUCKET = process.env.S3_BUCKET ?? "noddle-verify";

const NAME = "probe-sauvegarde";

let pass = 0;
let fail = 0;
const ok = (m: string) => {
  pass += 1;
  console.log(`  \x1b[32m✓\x1b[0m ${m}`);
};
const ko = (m: string) => {
  fail += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${m}`);
};

/**
 * Commande de montage qui DOIT réussir.
 *
 * `execArgv` rend un code de sortie que rien n'obligeait à lire : un
 * `CREATE TABLE` échouant sur une table déjà présente passait inaperçu, et le
 * test mesurait alors un dump minuscule en croyant en mesurer un gros. Un
 * banc d'essai qui ignore l'échec de son propre montage annonce des résultats
 * qui ne portent pas sur ce qu'il prétend.
 */
async function must(
  client: Awaited<ReturnType<typeof connect>>,
  argv: string[]
): Promise<string> {
  const r = await execArgv(client, argv);
  if (r.code !== 0) {
    throw new Error(
      `montage échoué (code ${r.code}) : ${argv.slice(0, 4).join(" ")} — ${r.stderr.slice(0, 300)}`
    );
  }
  return r.stdout;
}

const appKey = randomBytes(32);
const db = createDatabase({ url: DB_URL });
const privateKey = readFileSync(KEY, "utf8");

let ssh: Awaited<ReturnType<typeof connect>> | undefined;

await db.delete(backups);
await db.delete(backupDestinations);
await db.delete(databases);
await db.delete(environments);
await db.delete(projects);
await db.delete(servers).where(inArray(servers.host, [HOST]));

console.log(`\n\x1b[1mSauvegardes — VM ${HOST}, S3 ${S3_ENDPOINT}\x1b[0m`);

try {
  const [server] = await db
    .insert(servers)
    .values({
      host: HOST,
      name: "sauvegarde-probe-manager",
      role: "manager",
      sshPrivateKeyEncrypted: "placeholder",
      sshUser: USER,
      status: "connected",
      totalMemoryMb: 2048,
    })
    .returning();
  if (!server) {
    throw new Error("insertion serveur échouée");
  }
  await db
    .update(servers)
    .set({
      sshPrivateKeyEncrypted: encryptSecret(
        privateKey,
        appKey,
        secretContext.serverSshKey(server.id)
      ),
    })
    .where(eq(servers.id, server.id));

  const [dest] = await db
    .insert(backupDestinations)
    .values({
      accessKeyId: S3_KEY,
      bucket: S3_BUCKET,
      endpoint: S3_ENDPOINT,
      prefix: "sauvegardes",
      region: "us-east-1",
      secretAccessKeyEncrypted: "placeholder",
    })
    .returning();
  if (!dest) {
    throw new Error("insertion destination échouée");
  }
  await db
    .update(backupDestinations)
    .set({
      secretAccessKeyEncrypted: encryptSecret(
        S3_SECRET,
        appKey,
        secretContext.backupDestination(dest.id)
      ),
    })
    .where(eq(backupDestinations.id, dest.id));
  ok("destination S3 enregistrée, clé secrète chiffrée");

  // Noddle ne crée JAMAIS de compartiment : c'est une ressource que
  // l'utilisateur possède et nomme. Ce script ne s'arroge donc pas un droit
  // que le produit n'a pas — il échoue avec la marche à suivre.
  await checkDestination({
    accessKeyId: S3_KEY,
    bucket: S3_BUCKET,
    endpoint: S3_ENDPOINT,
    forcePathStyle: true,
    prefix: "sauvegardes",
    region: "us-east-1",
    secretAccessKey: S3_SECRET,
  });
  ok(`compartiment « ${S3_BUCKET} » joignable en écriture`);

  const ctx = {
    appKey,
    db,
    logRoot: "/tmp/noddle-backup-logs",
    networkName: "noddle-public",
  };

  ssh = await connect({ host: HOST, privateKey, user: USER });
  await removeService(dockerClient(ssh), databaseServiceName(NAME));
  // Le volume NE disparaît PAS avec le service — c'est tout l'intérêt d'un
  // volume nommé. Sans cette purge, chaque exécution hérite des tables de la
  // précédente et ne part donc pas de l'état qu'elle annonce.
  await execArgv(ssh, [
    "sh",
    "-c",
    `for i in $(seq 1 20); do docker volume rm ${databaseServiceName(NAME)} >/dev/null 2>&1 && exit 0; sleep 1; done; exit 0`,
  ]);

  const [proj] = await db
    .insert(projects)
    .values({ name: "sauvegarde-probe" })
    .returning();
  const [env] = await db
    .insert(environments)
    .values({ name: "production", projectId: proj?.id ?? "" })
    .returning();

  // ── Une vraie base, provisionnée par le code de la Phase 2 ───────────────
  const password = randomBytes(24).toString("hex");
  const [database] = await db
    .insert(databases)
    .values({
      engine: "postgres",
      environmentId: env?.id ?? "",
      name: NAME,
      rootPasswordEncrypted: "placeholder",
      rootUser: "noddle",
      serverId: server.id,
    })
    .returning();
  if (!database) {
    throw new Error("insertion base échouée");
  }
  await db
    .update(databases)
    .set({
      rootPasswordEncrypted: encryptSecret(
        password,
        appKey,
        secretContext.databasePassword(database.id)
      ),
    })
    .where(eq(databases.id, database.id));

  await provisionDatabase(ctx, database.id);
  ok("base Postgres provisionnée sur la VM");

  const containerId = await findDatabaseContainer(
    ssh,
    databaseServiceName(NAME)
  );
  ok(`conteneur retrouvé par label Swarm : ${containerId.slice(0, 12)}`);

  // ── Un témoin, pour que la sauvegarde ait un contenu vérifiable ──────────
  const witness = randomBytes(8).toString("hex");
  await must(ssh, [
    "docker",
    "exec",
    containerId,
    "psql",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    "noddle",
    "-c",
    `CREATE TABLE temoin(v text); INSERT INTO temoin VALUES ('${witness}')`,
  ]);
  ok(`témoin inséré : ${witness}`);

  const destination: BackupDestination = {
    accessKeyId: S3_KEY,
    bucket: S3_BUCKET,
    endpoint: S3_ENDPOINT,
    forcePathStyle: true,
    prefix: "sauvegardes",
    region: "us-east-1",
    secretAccessKey: S3_SECRET,
  };

  // ── 1. Le chemin nominal ────────────────────────────────────────────────
  const keyOk = backupObjectKey({
    backupId: "temoin",
    databaseName: NAME,
    extension: "dump",
    prefix: "sauvegardes",
    takenAt: new Date(),
  });
  const [row] = await db
    .insert(backups)
    .values({ databaseId: database.id, objectKey: keyOk })
    .returning();
  if (!row) {
    throw new Error("insertion sauvegarde échouée");
  }

  await runBackup(ctx, row.id);
  const done = await db.query.backups.findFirst({
    where: eq(backups.id, row.id),
  });
  if (done?.status === "completed" && (done?.sizeBytes ?? 0) > 0) {
    ok(`sauvegarde réussie : ${done.sizeBytes} octets, statut ${done.status}`);
  } else {
    ko(`statut ${done?.status}, taille ${done?.sizeBytes}`);
  }
  if (await objectExists(destination, keyOk)) {
    ok("l'objet est réellement dans le compartiment");
  } else {
    ko("aucun objet dans le compartiment malgré un statut réussi");
  }

  // ── 2. LE test du chantier : un dump interrompu en plein vol ─────────────
  // On grossit la base pour que le dump dure, puis on tue le conteneur
  // pendant qu'il coule. C'est le scénario réel — l'OOM killer emportant la
  // base pendant une sauvegarde — et il produit exactement la forme
  // dangereuse : des octets valides, un flux clos proprement, un contenu
  // incomplet.
  await must(ssh, [
    "docker",
    "exec",
    containerId,
    "psql",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    "noddle",
    "-c",
    // INCOMPRESSIBLE, et il a fallu deux essais pour y arriver :
    // `repeat('x', 400)` passait de 360 Mo à 3,8 Mo, puis
    // `repeat(md5(...), 10)` répétait le MÊME md5 dix fois par ligne, donc se
    // compressait encore. Des md5 DISTINCTS concaténés, eux, ne se compressent
    // pas. Sans ça le dump finissait avant le kill et le test annonçait un
    // défaut qui n'existait pas.
    "CREATE TABLE gros AS SELECT g, md5(random()::text) || md5(random()::text) || md5(random()::text) || md5(random()::text) AS bourrage FROM generate_series(1, 600000) g",
  ]);
  ok("table volumineuse et incompressible créée");

  const keyKo = backupObjectKey({
    backupId: "interrompu",
    databaseName: NAME,
    extension: "dump",
    prefix: "sauvegardes",
    takenAt: new Date(),
  });
  const [broken] = await db
    .insert(backups)
    .values({ databaseId: database.id, objectKey: keyKo })
    .returning();
  if (!broken) {
    throw new Error("insertion sauvegarde échouée");
  }

  // 900 ms : le dump complet est mesuré à ~2 s de façon stable sur cette VM,
  // donc la coupure tombe franchement à l'intérieur. Tuer plus tard revenait à
  // tester un dump déjà terminé.
  const killer = (async () => {
    await new Promise((r) => setTimeout(r, 900));
    const k = await connect({ host: HOST, privateKey, user: USER });
    try {
      await execArgv(k, ["docker", "kill", containerId]);
    } finally {
      disconnect(k);
    }
  })();

  let threw = false;
  try {
    await runBackup(ctx, broken.id);
  } catch {
    threw = true;
  }
  await killer;

  const brokenRow = await db.query.backups.findFirst({
    where: eq(backups.id, broken.id),
  });
  if (threw && brokenRow?.status === "failed") {
    ok(`dump interrompu : statut ${brokenRow.status}, job en erreur`);
  } else {
    ko(
      `dump interrompu mal traité : jeté=${threw} statut=${brokenRow?.status}`
    );
  }
  if (await objectExists(destination, keyKo)) {
    ko("DANGER : la moitié de dump est restée dans le compartiment");
  } else {
    ok("l'objet incomplet a été retiré du compartiment");
  }
  if (brokenRow?.errorMessage) {
    ok(`la cause est enregistrée : ${brokenRow.errorMessage.slice(0, 80)}…`);
  } else {
    ko("aucune cause enregistrée pour la sauvegarde échouée");
  }
} catch (err) {
  ko(`exception : ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof Error && err.stack) {
    console.log(err.stack.split("\n").slice(1, 5).join("\n"));
  }
} finally {
  if (ssh) {
    await removeService(dockerClient(ssh), databaseServiceName(NAME)).catch(
      () => {
        // rien à faire : le nettoyage ne doit pas masquer un échec réel
      }
    );
    disconnect(ssh);
  }
}

console.log(`\n\x1b[1mréussis ${pass}, échoués ${fail}\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
