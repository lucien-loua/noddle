// Vérifie le câblage BullMQ : un job déposé dans la file est bien pris par le
// PROCESSUS worker, pas seulement par un appel direct à runDeploy.
//
// C'est mince, mais « mince et non vérifié » est précisément ce qui a coûté du
// temps ailleurs. Ce test ne construit rien : il pointe un dépôt inexistant
// pour que le job échoue vite. Ce qu'on mesure, c'est que le worker le PREND,
// l'exécute et écrit le résultat en base — pas qu'un déploiement réussisse.
//
//   DATABASE_URL=… REDIS_URL=… node apps/worker/src/verify-queue.ts
import { randomBytes } from "node:crypto";
import { createDatabase } from "@noddle/db";
import {
  deployments,
  environments,
  projects,
  servers,
  services,
} from "@noddle/db/schema";
import { encryptSecret, secretContext } from "@noddle/shared/crypto";
import { Queue } from "bullmq";
import { eq } from "drizzle-orm";
import IORedis from "ioredis";

const DB_URL =
  process.env.DATABASE_URL ??
  "postgres://postgres:noddle@localhost:55432/noddle";
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:56379";
const APP_KEY_B64 = process.env.APP_KEY ?? "";

let pass = 0;
let fail = 0;
const ok = (m: string) => {
  pass += 1;
  console.log(`  [32m✓[0m ${m}`);
};
const ko = (m: string) => {
  fail += 1;
  console.log(`  [31m✗[0m ${m}`);
};

const appKey = APP_KEY_B64
  ? Buffer.from(APP_KEY_B64, "base64")
  : randomBytes(32);
const db = createDatabase({ url: DB_URL });
const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
const queue = new Queue("noddle-deploy", { connection });

try {
  const [srv] = await db
    .insert(servers)
    .values({
      host: "203.0.113.1", // TEST-NET-3 : injoignable par construction
      name: "queue-target",
      sshPrivateKeyEncrypted: "x",
      sshUser: "nobody",
    })
    .returning();
  await db
    .update(servers)
    .set({
      sshPrivateKeyEncrypted: encryptSecret(
        "-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END-----",
        appKey,
        secretContext.serverSshKey(srv?.id ?? "")
      ),
    })
    .where(eq(servers.id, srv?.id ?? ""));

  const [proj] = await db
    .insert(projects)
    .values({ name: "queue" })
    .returning();
  const [env] = await db
    .insert(environments)
    .values({ name: "production", projectId: proj?.id ?? "" })
    .returning();
  const [svc] = await db
    .insert(services)
    .values({
      environmentId: env?.id ?? "",
      gitBranch: "main",
      gitRepoUrl: "https://example.invalid/nope.git",
      name: "queue-probe",
      port: 3000,
      serverId: srv?.id ?? "",
      sourceType: "git",
    })
    .returning();

  const [dep] = await db
    .insert(deployments)
    .values({ serviceId: svc?.id ?? "", status: "queued", trigger: "manual" })
    .returning();
  ok("service et déploiement en attente créés");

  await queue.add("deploy", { deploymentId: dep?.id ?? "", kind: "deploy" });
  ok("job déposé dans la file");

  // Le worker doit le prendre et écrire un résultat. On attend un statut
  // TERMINAL : peu importe lequel, ce qui compte est que le processus ait
  // travaillé plutôt que laissé le job dormir.
  const deadline = Date.now() + 90_000;
  let finalStatus: string | undefined;

  while (Date.now() < deadline) {
    // biome-ignore lint/performance/noAwaitInLoops: sondage volontaire
    const row = await db.query.deployments.findFirst({
      where: eq(deployments.id, dep?.id ?? ""),
    });
    if (row && row.status !== "queued") {
      finalStatus = row.status;
      if (row.status === "failed" || row.status === "rolled_back") {
        break;
      }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  if (finalStatus) {
    ok(`le worker a pris le job et écrit un résultat : ${finalStatus}`);
  } else {
    ko("le job est resté en attente : le worker ne consomme pas la file");
  }

  const row = await db.query.deployments.findFirst({
    where: eq(deployments.id, dep?.id ?? ""),
  });
  if (row?.status === "failed" && row.errorMessage) {
    ok(`échec enregistré avec sa cause : ${row.errorMessage.slice(0, 60)}…`);
  } else {
    ko(`échec attendu avec message, obtenu ${row?.status}`);
  }

  const counts = await queue.getJobCounts("completed", "failed", "waiting");
  if ((counts.waiting ?? 0) === 0) {
    ok("la file est vide : rien n'est resté coincé");
  } else {
    ko(`${counts.waiting} job(s) encore en attente`);
  }
} catch (e) {
  ko(`exception : ${e instanceof Error ? e.message : String(e)}`);
} finally {
  await queue.close();
  await connection.quit();
}

console.log(`\n[1mréussis ${pass}, échoués ${fail}[0m\n`);
process.exit(fail === 0 ? 0 : 1);
