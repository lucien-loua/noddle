// Planification et rétention, contre du RÉEL.
//
//   STACK_HOST=192.168.252.3 node apps/worker/src/verify-backup-schedule.ts
//
// Deux questions, et aucune n'est « le passage s'exécute-t-il » :
//
//   1. une base due est-elle sauvegardée, et une base PAS due épargnée ?
//      Un planificateur qui déclenche tout le temps est aussi faux qu'un
//      planificateur qui ne déclenche jamais — il remplirait le compartiment
//      et masquerait la panne du jour où il s'arrête.
//   2. la rétention supprime-t-elle vraiment l'OBJET, pas seulement la ligne ?
//      Une ligne effacée sans son objet donne un compartiment qui grossit
//      sans fin, invisible depuis le dashboard.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type BackupDestination,
  backupObjectKey,
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
import { databaseServiceName, runBackup } from "#backup";
import { pruneBackups, sweepBackups } from "#backup-sweep";
import { provisionDatabase } from "#database";
import { removeService } from "#swarm";

const DB_URL =
  process.env.DATABASE_URL ??
  "postgres://postgres:noddle@localhost:55432/noddle";
const HOST = process.env.STACK_HOST ?? "192.168.252.3";
const USER = process.env.TARGET_USER ?? "ubuntu";
const KEY = process.env.SSH_KEY ?? join(homedir(), ".ssh", "id_ed25519");

const S3_ENDPOINT = process.env.S3_ENDPOINT ?? "http://localhost:9000";
const S3_KEY = process.env.S3_ACCESS_KEY ?? "rustfsadmin";
const S3_SECRET = process.env.S3_SECRET_KEY ?? "rustfsadmin";
const S3_BUCKET = process.env.S3_BUCKET ?? "noddle-verify";

const NAME = "probe-planif";
const PREFIX = "planif";

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

console.log(`\n\x1b[1mPlanification et rétention — VM ${HOST}\x1b[0m`);

const destination: BackupDestination = {
  accessKeyId: S3_KEY,
  bucket: S3_BUCKET,
  endpoint: S3_ENDPOINT,
  forcePathStyle: true,
  prefix: PREFIX,
  region: "us-east-1",
  secretAccessKey: S3_SECRET,
};

try {
  const [server] = await db
    .insert(servers)
    .values({
      host: HOST,
      name: "planif-probe-manager",
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
      prefix: PREFIX,
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

  const ctx = {
    appKey,
    db,
    logRoot: "/tmp/noddle-planif-logs",
    networkName: "noddle-public",
  };

  ssh = await connect({ host: HOST, privateKey, user: USER });
  await removeService(dockerClient(ssh), databaseServiceName(NAME));
  await execArgv(ssh, [
    "sh",
    "-c",
    `for i in $(seq 1 20); do docker volume rm ${databaseServiceName(NAME)} >/dev/null 2>&1 && exit 0; sleep 1; done; exit 0`,
  ]);

  const [proj] = await db
    .insert(projects)
    .values({ name: "planif-probe" })
    .returning();
  const [env] = await db
    .insert(environments)
    .values({ name: "production", projectId: proj?.id ?? "" })
    .returning();

  const [database] = await db
    .insert(databases)
    .values({
      backupRetention: 2,
      backupSchedule: "off",
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
        randomBytes(24).toString("hex"),
        appKey,
        secretContext.databasePassword(database.id)
      ),
    })
    .where(eq(databases.id, database.id));

  await provisionDatabase(ctx, database.id);
  ok("base Postgres provisionnée");

  const queued: string[] = [];
  const enqueue = async (id: string) => {
    queued.push(id);
    return await Promise.resolve(id);
  };

  // ── 1. `off` ne déclenche RIEN ────────────────────────────────────────────
  let r = await sweepBackups(ctx, enqueue);
  if (r.queued.length === 0) {
    ok("une base réglée sur « off » n'est jamais sauvegardée");
  } else {
    ko(`« off » a déclenché ${r.queued.length} sauvegarde(s)`);
  }

  // ── 2. `daily` sans historique EST due ───────────────────────────────────
  await db
    .update(databases)
    .set({ backupSchedule: "daily" })
    .where(eq(databases.id, database.id));
  r = await sweepBackups(ctx, enqueue);
  if (r.queued.length === 1) {
    ok("une base « daily » jamais sauvegardée est due immédiatement");
  } else {
    ko(`attendu 1 sauvegarde due, obtenu ${r.queued.length}`);
  }

  // Le passage DÉPOSE en file ; c'est le worker qui exécute. Ici on exécute
  // nous-mêmes, sinon la ligne resterait `queued` et le test suivant croirait
  // la base toujours due.
  const firstId = r.queued[0] ?? "";
  await runBackup(ctx, firstId);
  ok("la sauvegarde planifiée s'exécute et aboutit");

  // ── 3. Une base fraîchement sauvegardée n'est PLUS due ────────────────────
  r = await sweepBackups(ctx, enqueue);
  if (r.queued.length === 0) {
    ok("une base sauvegardée à l'instant n'est pas re-déclenchée");
  } else {
    ko(`re-déclenchement indu : ${r.queued.length}`);
  }

  // ── 4. Vieillir la sauvegarde la rend due à nouveau ──────────────────────
  // On recule la date en base plutôt que d'attendre 24 h : c'est la MÊME
  // colonne que lit le passage, donc le chemin testé est le vrai.
  await db
    .update(backups)
    .set({ createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) })
    .where(eq(backups.id, firstId));
  r = await sweepBackups(ctx, enqueue);
  if (r.queued.length === 1) {
    ok("une sauvegarde vieille de 25 h rend la base due à nouveau");
  } else {
    ko(`attendu 1 après vieillissement, obtenu ${r.queued.length}`);
  }
  await runBackup(ctx, r.queued[0] ?? "");

  // ── 5. La rétention supprime l'OBJET, pas seulement la ligne ─────────────
  // Rétention = 2. On fabrique une troisième sauvegarde réussie ; la plus
  // ancienne doit disparaître du compartiment.
  const oldest = await db.query.backups.findFirst({
    where: eq(backups.id, firstId),
  });
  const oldestKey = oldest?.objectKey ?? "";
  if (await objectExists(destination, oldestKey)) {
    ok("la plus ancienne sauvegarde est bien dans le compartiment");
  } else {
    ko("la plus ancienne sauvegarde est déjà absente");
  }

  const [third] = await db
    .insert(backups)
    .values({
      databaseId: database.id,
      objectKey: backupObjectKey({
        backupId: randomBytes(6).toString("hex"),
        databaseName: NAME,
        extension: "dump",
        prefix: PREFIX,
        takenAt: new Date(),
      }),
    })
    .returning();
  await runBackup(ctx, third?.id ?? "");

  const remaining = await db.query.backups.findMany({
    where: eq(backups.databaseId, database.id),
  });
  const completed = remaining.filter((b) => b.status === "completed");
  if (completed.length === 2) {
    ok(`rétention respectée : ${completed.length} sauvegardes gardées sur 3`);
  } else {
    ko(`rétention non respectée : ${completed.length} gardées, attendu 2`);
  }

  if (await objectExists(destination, oldestKey)) {
    ko("DANGER : la ligne a été purgée mais l'OBJET est resté dans le seau");
  } else {
    ok("l'objet de la sauvegarde purgée a bien été retiré du compartiment");
  }

  // ── 6. La purge ne touche pas ce qu'on garde ─────────────────────────────
  let allPresent = true;
  for (const b of completed) {
    // biome-ignore lint/performance/noAwaitInLoops: vérification séquentielle volontaire
    if (!(await objectExists(destination, b.objectKey))) {
      allPresent = false;
    }
  }
  if (allPresent) {
    ok("les sauvegardes conservées ont toutes leur objet");
  } else {
    ko("une sauvegarde conservée a perdu son objet");
  }

  // ── 7. Une purge idempotente ──────────────────────────────────────────────
  const again = await pruneBackups(ctx, database.id);
  if (again.length === 0) {
    ok("une seconde purge ne supprime rien de plus");
  } else {
    ko(`seconde purge a supprimé ${again.length} objet(s) en trop`);
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
        // le nettoyage ne doit pas masquer un échec réel
      }
    );
    disconnect(ssh);
  }
}

console.log(`\n\x1b[1mréussis ${pass}, échoués ${fail}\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
