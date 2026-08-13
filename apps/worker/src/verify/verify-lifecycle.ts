// TARGET_HOST=192.168.252.3 DATABASE_URL=… node apps/worker/src/verify/verify-lifecycle.ts
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createDatabase } from "@noddle/db";
import {
  deployments,
  environments,
  projects,
  servers,
  serviceDomains,
  services,
} from "@noddle/db/schema";
import { swarmServiceName } from "@noddle/shared/swarm-names";
import { connect, disconnect, dockerClient, exec } from "@noddle/ssh-executor";
import { removeService } from "@noddle/swarm-ops";
import { eq } from "drizzle-orm";
import { runDeploy } from "#deploy";
import { runLifecycle } from "#lifecycle";
import { seedSshKey, verifyCtx } from "#verify-seed";

const DB_URL =
  process.env.DATABASE_URL ??
  "postgres://postgres:noddle@localhost:55432/noddle";
const HOST = process.env.TARGET_HOST ?? "192.168.252.3";
const USER = process.env.TARGET_USER ?? "ubuntu";
const KEY = process.env.SSH_KEY ?? join(homedir(), ".ssh", "id_ed25519");
const NAME = "noddle-lifecycle";
const ORIGIN = "/opt/noddle-lifecycle-origin";

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
const sshKeyId = await seedSshKey(db, appKey, "verify-lifecycle", privateKey);
let ssh: Awaited<ReturnType<typeof connect>> | undefined;

/** What SWARM says, not what our DB says. */
async function swarmState(
  docker: ReturnType<typeof dockerClient>,
  name: string
): Promise<{ replicas: number | null; taskIds: string[] }> {
  const list = (await docker.listServices({
    filters: JSON.stringify({ name: [name] }),
  })) as unknown as Array<{
    Spec?: { Mode?: { Replicated?: { Replicas?: number } }; Name?: string };
  }>;
  const found = list.find((s) => s.Spec?.Name === name);
  const tasks = (await docker.listTasks({
    filters: JSON.stringify({ service: [name] }),
  })) as unknown as Array<{ ID?: string; Status?: { State?: string } }>;
  return {
    replicas: found?.Spec?.Mode?.Replicated?.Replicas ?? null,
    taskIds: tasks
      .filter((t) => t.Status?.State === "running")
      .map((t) => t.ID ?? ""),
  };
}

/** Wait until the number of RUNNING tasks reaches the target. */
async function waitForRunningTasks(
  docker: ReturnType<typeof dockerClient>,
  name: string,
  target: number,
  seconds = 90
): Promise<string[]> {
  const deadline = Date.now() + seconds * 1000;
  let last: string[] = [];
  while (Date.now() < deadline) {
    // biome-ignore lint/performance/noAwaitInLoops: intentional polling
    const state = await swarmState(docker, name);
    last = state.taskIds;
    if (last.length === target) {
      return last;
    }
    await sleep(2000);
  }
  return last;
}

try {
  ssh = await connect({ host: HOST, privateKey, user: USER });
  const docker = dockerClient(ssh);

  // Staging: a minimal HTTP-served repo, like verify-e2e.
  await exec(
    ssh,
    `sudo rm -rf ${ORIGIN} && sudo mkdir -p ${ORIGIN} && sudo chown -R "$USER" ${ORIGIN} && ` +
      // A NODE server, not `python3 -m http.server`: a nixpacks image for a
      // Node project does not ship python3, and the task exited 127
      // (command not found) — faulty staging that blamed the code.
      `cd ${ORIGIN} && ` +
      `printf '%s' '{"name":"l","scripts":{"start":"node s.js"}}' > package.json && ` +
      `printf '%s' 'const p=process.env.PORT||3000;require("http").createServer((q,r)=>r.end("lifecycle")).listen(p)' > s.js && ` +
      "git init -q -b main . 2>/dev/null; git config user.email e@x && git config user.name e && " +
      "git add -A && git commit -q -m v1"
  );

  await db.delete(deployments);
  await db.delete(services);
  await db.delete(environments);
  await db.delete(projects);
  await db.delete(servers);

  const [srv] = await db
    .insert(servers)
    .values({
      host: HOST,
      name: "lifecycle-manager",
      role: "manager",
      sshKeyId,
      sshUser: USER,
      status: "connected",
      totalMemoryMb: 2048,
    })
    .returning();
  if (!srv) {
    throw new Error("server insert failed");
  }

  const [proj] = await db
    .insert(projects)
    .values({ name: "lifecycle" })
    .returning();
  const [env] = await db
    .insert(environments)
    .values({ name: "production", projectId: proj?.id ?? "" })
    .returning();
  const [svc] = await db
    .insert(services)
    .values({
      buildMethod: "nixpacks",
      environmentId: env?.id ?? "",
      gitBranch: "main",
      gitRepoUrl: `file://${ORIGIN}`,
      name: NAME,
      port: 3000,
      serverId: srv.id,
      sourceType: "git",
    })
    .returning();
  if (!svc) {
    throw new Error("service insert failed");
  }
  await db.insert(serviceDomains).values({
    host: `${NAME}.${HOST.replaceAll(".", "-")}.sslip.io`,
    serviceId: svc.id,
  });
  const swarmName = swarmServiceName(svc);
  await removeService(docker, swarmName);

  const ctx = verifyCtx({ appKey, db });
  const route = { networkName: "noddle-public" };
  const build = { logRoot: "/tmp/noddle-lifecycle-logs" };

  const [dep] = await db
    .insert(deployments)
    .values({ serviceId: svc.id, status: "queued", trigger: "manual" })
    .returning();
  console.log("    (initial build — a few minutes…)");
  await runDeploy(ctx, route, build, { deploymentId: dep?.id ?? "" });

  const started = await waitForRunningTasks(docker, swarmName, 1);
  if (started.length === 1) {
    ok("service deployed, one task running");
  } else {
    ko(`deploy: ${started.length} task(s) instead of 1`);
    throw new Error("abort");
  }

  // ── STOP ────────────────────────────────────────────────────────────────
  await runLifecycle(ctx, svc.id, "stop");
  const afterStop = await swarmState(docker, swarmName);
  if (afterStop.replicas === 0) {
    ok("Swarm moved to 0 desired replicas");
  } else {
    ko(`desired replicas: ${afterStop.replicas} instead of 0`);
  }

  // Desired count alone is not enough: the container takes time to fall, and
  // a "stopped" service that still answers would be the worst of both.
  const stoppedTasks = await waitForRunningTasks(docker, swarmName, 0);
  if (stoppedTasks.length === 0) {
    ok("no more running tasks — the application is actually off");
  } else {
    ko(`${stoppedTasks.length} task(s) still running after stop`);
  }

  // The Swarm service must SURVIVE: that is what makes restart instant and
  // keeps the app from changing nodes.
  if (afterStop.replicas === null) {
    ko("the Swarm service disappeared — stop deleted it");
  } else {
    ok("the Swarm service still exists (stop ≠ remove)");
  }

  const stoppedRow = await db.query.services.findFirst({
    where: eq(services.id, svc.id),
  });
  if (stoppedRow?.status === "stopped") {
    ok('DB says "stopped"');
  } else {
    ko(`DB status: ${stoppedRow?.status}`);
  }

  // ── START ───────────────────────────────────────────────────────────────
  await runLifecycle(ctx, svc.id, "start");
  const restarted = await waitForRunningTasks(docker, swarmName, 1);
  if (restarted.length === 1) {
    ok("started: one task running again");
  } else {
    ko(`start: ${restarted.length} task(s) instead of 1`);
  }
  const runningRow = await db.query.services.findFirst({
    where: eq(services.id, svc.id),
  });
  if (runningRow?.status === "running") {
    ok('DB says "running"');
  } else {
    ko(`DB status: ${runningRow?.status}`);
  }

  // ── RESTART ─────────────────────────────────────────────────────────────
  //
  // The assertion that matters: the task ID must CHANGE. "Still running" was
  // already true before, and an update without `ForceUpdate` lets Swarm do
  // nothing at all.
  const before = restarted[0] ?? "";
  await runLifecycle(ctx, svc.id, "restart");
  const deadline = Date.now() + 120_000;
  let after = before;
  while (Date.now() < deadline) {
    // biome-ignore lint/performance/noAwaitInLoops: intentional polling
    const s = await swarmState(docker, swarmName);
    const [id] = s.taskIds;
    if (s.taskIds.length === 1 && id && id !== before) {
      after = id;
      break;
    }
    await sleep(2000);
  }
  if (after === before) {
    ko("the task is the SAME — restart recreated nothing");
  } else {
    ok(
      `restarted: task changed (${before.slice(0, 10)} → ${after.slice(0, 10)})`
    );
  }

  const afterRestart = await db.query.services.findFirst({
    where: eq(services.id, svc.id),
  });
  if (afterRestart?.status === "running") {
    ok('a restart leaves the service "running"');
  } else {
    ko(`status after restart: ${afterRestart?.status}`);
  }
} catch (err) {
  ko(`exception: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  if (ssh) {
    const docker = dockerClient(ssh);
    const leftovers = await docker.listServices();
    for (const s of leftovers) {
      const n = s.Spec?.Name;
      if (n?.startsWith(NAME)) {
        // biome-ignore lint/performance/noAwaitInLoops: sequential cleanup
        await removeService(docker, n).catch(() => {
          // best-effort
        });
      }
    }
    disconnect(ssh);
  }
}

console.log(`\npassed ${pass}, failed ${fail}`);
process.exit(fail === 0 ? 0 : 1);
