// tier: vm
// runtime: bun
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { encryptSecret, loadAppKey, secretContext } from "@noddle/crypto";
import { createDatabase } from "@noddle/db";
import {
  account,
  deploymentLogs,
  deployments,
  environments,
  envVars,
  projects,
  servers,
  serviceDomains,
  services,
  session,
  sshKeys,
  user,
} from "@noddle/db/schema";
import { DEPLOY_QUEUE_NAME, deployJobSchema } from "@noddle/deploy-contract";
import { devStack } from "@noddle/testing/dev-stack";
import { devTarget } from "@noddle/testing/dev-target";
import { Queue } from "bullmq";
import { desc, eq } from "drizzle-orm";
import IORedis from "ioredis";

const DB_URL = devStack().databaseUrl;
const REDIS_URL = devStack().redisUrl;
const TARGET = devTarget();

const PORT = Number(process.env.PORT ?? 3312);
const BASE = `http://localhost:${PORT}`;
const SERVICE_NAME = "noddle-live";
const ORIGIN = "/opt/noddle-live-origin";

const EMAIL = "admin@noddle.test";
const PASSWORD = "a-reasonably-long-password";

const DEPLOY_TIMEOUT_MS = 8 * 60 * 1000;

let pass = 0;
let fail = 0;
const ok = (m: string) => {
  pass += 1;
  console.log(`  \u001B[32m✓\u001B[0m ${m}`);
};
const ko = (m: string) => {
  fail += 1;
  console.log(`  \u001B[31m✗\u001B[0m ${m}`);
};

const appKey = loadAppKey(process.env.APP_KEY);
const db = createDatabase({ url: DB_URL });
const redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
const queue = new Queue(DEPLOY_QUEUE_NAME, { connection: redis });

let cookie = "";

async function call(
  path: string,
  init: RequestInit = {}
): Promise<{ body: string; response: Response }> {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
      ...init.headers,
    },
    redirect: "manual",
  });
  const setCookie = response.headers.getSetCookie?.() ?? [];
  if (setCookie.length > 0) {
    cookie = setCookie.map((c) => c.split(";")[0]).join("; ");
  }
  return { body: await response.text(), response };
}

const procs: ReturnType<typeof Bun.spawn>[] = [];
const repoRoot = new URL("../../..", import.meta.url).pathname;

async function waitForWeb(): Promise<boolean> {
  for (let i = 0; i < 120; i += 1) {
    try {
      const r = await fetch(`${BASE}/api/auth/ok`);
      if (r.ok) {
        return true;
      }
    } catch {}
    await sleep(500);
  }
  return false;
}

async function cleanupDb(): Promise<void> {
  await db.delete(session);
  await db.delete(account);
  await db.delete(user);
  await db.delete(deploymentLogs);
  await db.delete(deployments);
  await db.delete(envVars);
  await db.delete(services);
  await db.delete(environments);
  await db.delete(projects);
  await db.delete(servers);
  await queue.obliterate({ force: true }).catch(() => {});
}

try {
  await cleanupDb();

  const remoteScript = [
    `sudo rm -rf '${ORIGIN}'`,
    `sudo mkdir -p '${ORIGIN}'`,
    `sudo chown -R "$USER" '${ORIGIN}'`,
    `cd '${ORIGIN}'`,
    `printf '%s' '{"name":"live","scripts":{"start":"node s.js"}}' > package.json`,
    `printf '%s' 'const p=process.env.PORT||3000;require("http").createServer((q,r)=>r.end("live "+(process.env.GREETING||"?"))).listen(p)' > s.js`,
    "git init -q -b main .",
    "git config user.email e@x",
    "git config user.name e",
    "git add -A",
    "git commit -q -m init",
  ].join(" && ");

  const seed = Bun.spawnSync([
    "ssh",
    "-i",
    TARGET.keyPath,
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "UserKnownHostsFile=/dev/null",
    `${TARGET.user}@${TARGET.host}`,
    remoteScript,
  ]);
  if (seed.exitCode === 0) {
    ok("source repository created on the VM");
  } else {
    ko(
      `creating the source repository: ${seed.stderr.toString().slice(0, 200)}`
    );
    throw new Error("aborting");
  }

  const foundKey = await db.query.sshKeys.findFirst({
    where: eq(sshKeys.name, "live-target"),
  });
  const sshKeyId = foundKey?.id ?? crypto.randomUUID();
  const keyValues = {
    id: sshKeyId,
    name: "live-target",
    privateKeyEncrypted: encryptSecret(
      TARGET.privateKey,
      appKey,
      secretContext.sshKey(sshKeyId)
    ),
  };
  if (foundKey) {
    await db.update(sshKeys).set(keyValues).where(eq(sshKeys.id, sshKeyId));
  } else {
    await db.insert(sshKeys).values(keyValues);
  }
  const [srv] = await db
    .insert(servers)
    .values({
      host: TARGET.host,
      name: "live-target",
      role: "manager",
      sshKeyId,
      sshUser: TARGET.user,
      totalMemoryMb: 2048,
    })
    .returning();

  const [proj] = await db.insert(projects).values({ name: "live" }).returning();
  const [env] = await db
    .insert(environments)
    .values({ name: "production", projectId: proj?.id ?? "" })
    .returning();
  const [svc] = await db
    .insert(services)
    .values({
      environmentId: env?.id ?? "",
      gitBranch: "main",
      gitRepoUrl: `file://${ORIGIN}`,
      name: SERVICE_NAME,
      port: 3000,
      serverId: srv?.id ?? "",
      sourceType: "git",
    })
    .returning();
  const serviceId = svc?.id ?? "";
  if (svc) {
    await db.insert(serviceDomains).values({
      host: `${SERVICE_NAME}.${TARGET.host.replaceAll(".", "-")}.sslip.io`,
      serviceId: svc.id,
    });
  }
  ok("server and service registered");

  procs.push(
    Bun.spawn(["node", "src/index.ts"], {
      cwd: join(repoRoot, "apps/worker"),
      env: process.env,
      stderr: "pipe",
      stdout: "pipe",
    }),
    Bun.spawn(["bun", "run", "server.ts"], {
      cwd: join(repoRoot, "apps/dashboard"),
      env: { ...process.env, BETTER_AUTH_URL: BASE, PORT: String(PORT) },
      stderr: "pipe",
      stdout: "pipe",
    })
  );

  if (await waitForWeb()) {
    ok("worker (Node) and web (Bun) started, two distinct processes");
  } else {
    ko("the web app did not start");
    throw new Error("aborting");
  }

  await call("/api/auth/sign-up/email", {
    body: JSON.stringify({ email: EMAIL, name: "admin", password: PASSWORD }),
    method: "POST",
  });
  if (cookie.length > 0) {
    ok("administrator created and signed in");
  } else {
    ko("could not sign in");
    throw new Error("aborting");
  }

  const [dep] = await db
    .insert(deployments)
    .values({ serviceId, status: "queued", trigger: "manual" })
    .returning();
  const deploymentId = dep?.id ?? "";

  const controller = new AbortController();
  const streamed = fetch(`${BASE}/api/logs/${deploymentId}`, {
    headers: { Cookie: cookie },
    signal: controller.signal,
  });

  await queue.add(
    "deploy",
    deployJobSchema.parse({ deploymentId, kind: "deploy" })
  );
  ok("job queued — real build in progress, a few minutes…");

  const response = await streamed;
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let received = "";
  let ended = false;

  const pump = (async () => {
    if (!reader) {
      return;
    }
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        return;
      }
      received += decoder.decode(chunk.value, { stream: true });
      if (received.includes("event: end")) {
        ended = true;
        return;
      }
    }
  })().catch(() => {});

  await Promise.race([pump, sleep(DEPLOY_TIMEOUT_MS)]);
  controller.abort();
  await pump;

  if (ended) {
    ok("the SSE stream closed itself on the end message");
  } else {
    ko("no end message received before timeout");
  }

  const markers: [string, string][] = [
    ["▸ build capped at", "the build cap announced by the worker"],
    ["Railpack", "railpack's own output"],
    ["#", "BuildKit's output (--progress plain)"],
    ["▸ Swarm switchover", "the Swarm switchover"],
    ["✓ deployment accepted", "the deployment being accepted"],
  ];
  for (const [needle, label] of markers) {
    if (received.includes(needle)) {
      ok(`${label} made it to the dashboard`);
    } else {
      ko(`${label} is missing from the stream`);
    }
  }

  console.log(
    `\n  (${received.length} bytes of SSE received by the web app)\n`
  );

  const row = await db.query.deployments.findFirst({
    where: eq(deployments.id, deploymentId),
  });
  if (row?.status === "succeeded" && row.imageTag) {
    ok(`deployment succeeded, image ${row.imageTag}`);
  } else {
    ko(`status ${row?.status}, error: ${row?.errorMessage ?? "—"}`);
  }

  {
    const { body } = await call("/");
    if (body.includes(SERVICE_NAME) && body.includes("Running")) {
      ok("the dashboard shows the service as running");
    } else {
      ko("the dashboard doesn't show the service as running");
    }
  }

  if (row?.imageTag) {
    await queue.add(
      "rollback",
      deployJobSchema.parse({
        imageTag: row.imageTag,
        kind: "rollback",
        serviceId,
      })
    );

    const rollbackDeadline = Date.now() + 3 * 60 * 1000;
    let replayed: typeof row | undefined;
    while (Date.now() < rollbackDeadline) {
      const latest = await db.query.deployments.findFirst({
        orderBy: desc(deployments.createdAt),
        where: eq(deployments.serviceId, serviceId),
      });
      if (latest && latest.id !== deploymentId && latest.finishedAt) {
        replayed = latest;
        break;
      }
      await sleep(3000);
    }

    if (replayed?.status === "succeeded" && replayed.trigger === "rollback") {
      ok("rollback: the image from history was replayed without a rebuild");
    } else {
      ko(`rollback: status ${replayed?.status ?? "no deployment"}`);
    }
  }
} catch (error) {
  ko(`exception: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  for (const p of procs) {
    p.kill();
  }
  await queue.close();
  await redis.quit();
}

console.log(`\n\u001B[1mpassed ${pass}, failed ${fail}\u001B[0m\n`);
process.exit(fail === 0 ? 0 : 1);
