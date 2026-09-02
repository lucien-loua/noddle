// tier: local
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { createDatabase } from "@noddle/db";
import {
  deployments,
  environments,
  projects,
  servers,
  services,
} from "@noddle/db/schema";
import { DEPLOY_QUEUE_NAME, deployJobSchema } from "@noddle/deploy-contract";
import { devStack } from "@noddle/testing/dev-stack";
import { Queue } from "bullmq";
import { eq } from "drizzle-orm";
import IORedis from "ioredis";

import { seedSshKey } from "#verify-seed";

const DB_URL = devStack().databaseUrl;
const REDIS_URL = devStack().redisUrl;
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

const QUEUE_HOST = "203.0.113.1";

const appKey = APP_KEY_B64
  ? Buffer.from(APP_KEY_B64, "base64")
  : randomBytes(32);
const db = createDatabase({ url: DB_URL });
const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
const queue = new Queue(DEPLOY_QUEUE_NAME, { connection });

try {
  const sshKeyId = await seedSshKey(
    db,
    appKey,
    "verify-queue",
    "-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END-----"
  );
  await db.delete(projects).where(eq(projects.name, "queue"));
  await db.delete(servers).where(eq(servers.host, QUEUE_HOST));

  const [srv] = await db
    .insert(servers)
    .values({
      host: QUEUE_HOST,
      name: "queue-target",
      sshKeyId,
      sshUser: "nobody",
    })
    .returning();

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
  ok("service and pending deployment created");

  await queue.add(
    "deploy",
    deployJobSchema.parse({ deploymentId: dep?.id ?? "", kind: "deploy" })
  );
  ok("job dropped into the queue");

  const deadline = Date.now() + 90_000;
  let finalStatus: string | undefined;

  while (Date.now() < deadline) {
    const row = await db.query.deployments.findFirst({
      where: eq(deployments.id, dep?.id ?? ""),
    });
    if (row && row.status !== "queued") {
      finalStatus = row.status;
      if (row.status === "failed" || row.status === "rolled_back") {
        break;
      }
    }
    await sleep(2000);
  }

  if (finalStatus) {
    ok(`the worker picked up the job and wrote a result: ${finalStatus}`);
  } else {
    ko("the job stayed queued: the worker isn't consuming the queue");
  }

  const row = await db.query.deployments.findFirst({
    where: eq(deployments.id, dep?.id ?? ""),
  });
  if (row?.status === "failed" && row.errorMessage) {
    ok(`failure recorded with its cause: ${row.errorMessage.slice(0, 60)}…`);
  } else {
    ko(`expected failure with message, got ${row?.status}`);
  }

  const counts = await queue.getJobCounts("completed", "failed", "waiting");
  if ((counts.waiting ?? 0) === 0) {
    ok("the queue is empty: nothing stayed stuck");
  } else {
    ko(`${counts.waiting} job(s) still waiting`);
  }
} catch (error) {
  ko(`exception: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await queue.close();
  await connection.quit();
}

console.log(`\n[1mpassed ${pass}, failed ${fail}[0m\n`);
process.exit(fail === 0 ? 0 : 1);
