// Restauration, contre du RÉEL — c'est le test qui décide si les sauvegardes
// servent à quelque chose.
//
//   STACK_HOST=192.168.252.3 node apps/worker/src/verify-restore.ts
//
// « Le job se termine sans erreur » ne prouve rien. La seule question qui
// compte est : **la donnée d'avant est-elle revenue, et celle d'après
// a-t-elle disparu ?** Donc chaque moteur suit la même trame :
//
//   témoin AVANT → sauvegarde → témoin APRÈS → restauration
//   → AVANT doit être là, APRÈS ne doit plus y être.
//
// Redis passe par le chemin le plus retors du chantier : il tourne en
// `--appendonly yes`, donc poser un RDB et redémarrer ne restaure RIEN
// (mesuré). Ce fichier le vérifie sur une vraie instance.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type BackupDestination,
  backupObjectKey,
  deleteObject,
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
import {
  decryptSecret,
  encryptSecret,
  secretContext,
} from "@noddle/shared/crypto";
import {
  connect,
  disconnect,
  dockerClient,
  execArgv,
} from "@noddle/ssh-executor";
import { eq, inArray } from "drizzle-orm";
import { databaseServiceName, findDatabaseContainer, runBackup } from "#backup";
import { provisionDatabase } from "#database";
import { runRestore } from "#restore";
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

const PG_NAME = "probe-restore-pg";
const REDIS_NAME = "probe-restore-redis";

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

async function must(
  client: Awaited<ReturnType<typeof connect>>,
  argv: string[]
): Promise<string> {
  const r = await execArgv(client, argv);
  if (r.code !== 0) {
    throw new Error(
      `montage échoué (code ${r.code}) : ${argv.slice(0, 5).join(" ")} — ${r.stderr.slice(0, 300)}`
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

console.log(`\n\x1b[1mRestauration — VM ${HOST}, S3 ${S3_ENDPOINT}\x1b[0m`);

const destination: BackupDestination = {
  accessKeyId: S3_KEY,
  bucket: S3_BUCKET,
  endpoint: S3_ENDPOINT,
  forcePathStyle: true,
  prefix: "restaurations",
  region: "us-east-1",
  secretAccessKey: S3_SECRET,
};

try {
  const [server] = await db
    .insert(servers)
    .values({
      host: HOST,
      name: "restore-probe-manager",
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
      prefix: "restaurations",
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
    logRoot: "/tmp/noddle-restore-logs",
    networkName: "noddle-public",
  };

  ssh = await connect({ host: HOST, privateKey, user: USER });
  const [proj] = await db
    .insert(projects)
    .values({ name: "restore-probe" })
    .returning();
  const [env] = await db
    .insert(environments)
    .values({ name: "production", projectId: proj?.id ?? "" })
    .returning();

  const provision = async (name: string, engine: "postgres" | "redis") => {
    if (!ssh) {
      throw new Error("pas de connexion");
    }
    await removeService(dockerClient(ssh), databaseServiceName(name));
    // Le volume survit au service : sans purge, on hériterait de l'exécution
    // précédente et le test ne partirait pas de l'état qu'il annonce.
    await execArgv(ssh, [
      "sh",
      "-c",
      `for i in $(seq 1 20); do docker volume rm ${databaseServiceName(name)} >/dev/null 2>&1 && exit 0; sleep 1; done; exit 0`,
    ]);
    const [row] = await db
      .insert(databases)
      .values({
        engine,
        environmentId: env?.id ?? "",
        name,
        rootPasswordEncrypted: "placeholder",
        rootUser: engine === "postgres" ? "noddle" : null,
        serverId: server.id,
      })
      .returning();
    if (!row) {
      throw new Error(`insertion base ${name} échouée`);
    }
    await db
      .update(databases)
      .set({
        rootPasswordEncrypted: encryptSecret(
          randomBytes(24).toString("hex"),
          appKey,
          secretContext.databasePassword(row.id)
        ),
      })
      .where(eq(databases.id, row.id));
    await provisionDatabase(ctx, row.id);
    return row;
  };

  const takeBackup = async (databaseId: string, name: string, ext: string) => {
    const [row] = await db
      .insert(backups)
      .values({
        databaseId,
        objectKey: backupObjectKey({
          backupId: randomBytes(6).toString("hex"),
          databaseName: name,
          extension: ext,
          prefix: "restaurations",
          takenAt: new Date(),
        }),
      })
      .returning();
    if (!row) {
      throw new Error("insertion sauvegarde échouée");
    }
    await runBackup(ctx, row.id);
    return row;
  };

  // ═══ POSTGRES ═══════════════════════════════════════════════════════════
  const pg = await provision(PG_NAME, "postgres");
  ok("base Postgres provisionnée");

  const pgContainer = await findDatabaseContainer(
    ssh,
    databaseServiceName(PG_NAME)
  );
  const psql = (sql: string) => [
    "docker",
    "exec",
    pgContainer,
    "psql",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    "noddle",
    "-tA",
    "-c",
    sql,
  ];

  await must(ssh, psql("CREATE TABLE temoin(v text)"));
  await must(ssh, psql("INSERT INTO temoin VALUES ('avant')"));
  const pgBackup = await takeBackup(pg.id, PG_NAME, "dump");
  ok(`sauvegarde Postgres prise (${pgBackup.objectKey.split("/").pop()})`);

  await must(ssh, psql("INSERT INTO temoin VALUES ('apres')"));
  const before = await must(ssh, psql("SELECT v FROM temoin ORDER BY v"));
  ok(`état avant restauration : ${before.trim().split("\n").join(", ")}`);

  await runRestore(ctx, { backupId: pgBackup.id, databaseId: pg.id });
  const after = (await must(ssh, psql("SELECT v FROM temoin ORDER BY v")))
    .trim()
    .split("\n")
    .filter((l) => l !== "");

  if (after.length === 1 && after[0] === "avant") {
    ok("Postgres restauré : « avant » est revenu, « apres » a disparu");
  } else {
    ko(`Postgres mal restauré : ${JSON.stringify(after)}`);
  }

  const safety = await db.query.backups.findMany({
    where: eq(backups.kind, "pre_restore"),
  });
  if (safety.length === 1 && safety[0]?.status === "completed") {
    ok("une sauvegarde de sûreté a été prise avant la restauration");
  } else {
    ko(`sauvegarde de sûreté absente ou incomplète : ${safety.length}`);
  }

  // ═══ REFUS ══════════════════════════════════════════════════════════════
  const [failed] = await db
    .insert(backups)
    .values({
      databaseId: pg.id,
      objectKey: "restaurations/inexistant.dump",
      status: "failed",
    })
    .returning();
  try {
    await runRestore(ctx, { backupId: failed?.id ?? "", databaseId: pg.id });
    ko("une sauvegarde échouée a été acceptée pour restauration");
  } catch {
    ok("une sauvegarde échouée est refusée");
  }

  // Objet retiré du compartiment à la main : la table dit qu'il existe, le
  // compartiment dit le contraire, et c'est le compartiment qui a raison.
  const orphan = await takeBackup(pg.id, PG_NAME, "dump");
  await deleteObject(destination, orphan.objectKey);
  try {
    await runRestore(ctx, { backupId: orphan.id, databaseId: pg.id });
    ko("une restauration a démarré alors que l'objet est absent");
  } catch {
    ok("objet absent du compartiment : refus AVANT de toucher à la base");
  }
  const stillThere = (await must(ssh, psql("SELECT v FROM temoin ORDER BY v")))
    .trim()
    .split("\n")
    .filter((l) => l !== "");
  if (stillThere.length === 1 && stillThere[0] === "avant") {
    ok("la base est intacte après le refus");
  } else {
    ko(`la base a été abîmée par une restauration refusée : ${stillThere}`);
  }

  // ═══ REDIS — le piège de l'AOF ══════════════════════════════════════════
  const rd = await provision(REDIS_NAME, "redis");
  ok("base Redis provisionnée");

  const rdRow = await db.query.databases.findFirst({
    where: eq(databases.id, rd.id),
  });
  const redisContainer = await findDatabaseContainer(
    ssh,
    databaseServiceName(REDIS_NAME)
  );
  // Le mot de passe est celui que Noddle a généré : on le relit par le même
  // chemin que le worker plutôt que d'en inventer un.
  const redisPassword = decryptSecret(
    rdRow?.rootPasswordEncrypted ?? "",
    appKey,
    secretContext.databasePassword(rd.id)
  );
  const redis = (...args: string[]) => [
    "docker",
    "exec",
    "-e",
    `REDISCLI_AUTH=${redisPassword}`,
    redisContainer,
    "redis-cli",
    ...args,
  ];

  await must(ssh, redis("SET", "avant", "oui"));
  const rdBackup = await takeBackup(rd.id, REDIS_NAME, "rdb");
  ok("sauvegarde Redis prise");

  await must(ssh, redis("SET", "apres", "oui"));
  const rBefore = (await must(ssh, redis("KEYS", "*")))
    .trim()
    .split("\n")
    .sort();
  ok(`état avant restauration : ${rBefore.join(", ")}`);

  await runRestore(ctx, { backupId: rdBackup.id, databaseId: rd.id });

  // Le conteneur a changé : le service a été redescendu puis relancé.
  const redisAfterContainer = await findDatabaseContainer(
    ssh,
    databaseServiceName(REDIS_NAME)
  );
  const redis2 = (...args: string[]) => [
    "docker",
    "exec",
    "-e",
    `REDISCLI_AUTH=${redisPassword}`,
    redisAfterContainer,
    "redis-cli",
    ...args,
  ];
  const rAfter = (await must(ssh, redis2("KEYS", "*")))
    .trim()
    .split("\n")
    .filter((l) => l !== "")
    .sort();

  if (rAfter.length === 1 && rAfter[0] === "avant") {
    ok("Redis restauré : « avant » est revenu, « apres » a disparu");
  } else {
    ko(
      `Redis mal restauré : ${JSON.stringify(rAfter)} — l'AOF a-t-il gagné sur le RDB ?`
    );
  }
} catch (err) {
  ko(`exception : ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof Error && err.stack) {
    console.log(err.stack.split("\n").slice(1, 5).join("\n"));
  }
} finally {
  if (ssh) {
    for (const n of [PG_NAME, REDIS_NAME]) {
      // biome-ignore lint/performance/noAwaitInLoops: nettoyage séquentiel volontaire
      await removeService(dockerClient(ssh), databaseServiceName(n)).catch(
        () => {
          // le nettoyage ne doit pas masquer un échec réel
        }
      );
    }
    disconnect(ssh);
  }
}

console.log(`\n\x1b[1mréussis ${pass}, échoués ${fail}\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
