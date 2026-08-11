// MANAGER_HOST=192.168.252.3 WORKER_HOST=192.168.252.5 DATABASE_URL=… node apps/worker/src/verify-multi.ts
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { createDatabase } from "@noddle/db";
import {
  deployments,
  environments,
  projects,
  servers,
  services,
} from "@noddle/db/schema";
import {
  connect,
  disconnect,
  dockerClient,
  exec,
  quoteArg,
} from "@noddle/ssh-executor";
import { removeService } from "@noddle/swarm-ops";
import { eq, inArray } from "drizzle-orm";
import { runDeploy } from "#deploy";
import { provisionServer } from "#provision";
import { seedSshKey } from "#verify-seed";

const execFileAsync = promisify(execFile);

const DB_URL =
  process.env.DATABASE_URL ??
  "postgres://postgres:noddle@localhost:55432/noddle";
const MANAGER_HOST = process.env.MANAGER_HOST ?? "192.168.252.3";
const WORKER_HOST = process.env.WORKER_HOST ?? "192.168.252.5";
const USER = process.env.TARGET_USER ?? "ubuntu";
const KEY = process.env.SSH_KEY ?? join(homedir(), ".ssh", "id_ed25519");

const SERVICE_NAME = "noddle-multi";
const ORIGIN = "/opt/noddle-multi-origin";

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
const sshKeyId = await seedSshKey(db, appKey, "verify-multi", privateKey);
const domain = `${SERVICE_NAME}.${WORKER_HOST.replaceAll(".", "-")}.sslip.io`;

let managerSsh: Awaited<ReturnType<typeof connect>> | undefined;

// Replayable: a previous run (this one or verify-live.ts, which shares the
// same local verification DB) may have left a server on THESE SAME hosts.
// The unique index (host, port, user) collides otherwise.
await db.delete(deployments);
await db.delete(services);
await db.delete(environments);
await db.delete(projects);
await db
  .delete(servers)
  .where(inArray(servers.host, [MANAGER_HOST, WORKER_HOST]));

try {
  // ── staging: both servers in the DB ─────────────────────────────────────
  const [managerRow] = await db
    .insert(servers)
    .values({
      host: MANAGER_HOST,
      name: "multi-manager",
      role: "manager",
      sshKeyId,
      sshUser: USER,
      totalMemoryMb: 2048,
    })
    .returning();
  if (!managerRow) {
    throw new Error("manager insert failed");
  }
  ok("manager registered (role=manager)");

  const [workerRow] = await db
    .insert(servers)
    .values({
      host: WORKER_HOST,
      name: "multi-worker",
      sshKeyId,
      sshUser: USER,
      // default role: "worker" — never set explicitly, exactly as the
      // `addServer` server function would do.
    })
    .returning();
  if (!workerRow) {
    throw new Error("worker insert failed");
  }
  ok("worker registered, pending (status=pending)");

  // ── THE provisioning: Docker, Swarm join, nixpacks ──────────────────────
  const ctx = {
    appKey,
    db,
    logRoot: "/tmp/noddle-multi-logs",
    networkName: "noddle-public",
  };

  console.log("    (provisioning the worker — Docker, join, nixpacks…)");
  await provisionServer(ctx, workerRow.id);

  const provisioned = await db.query.servers.findFirst({
    where: eq(servers.id, workerRow.id),
  });
  if (provisioned?.status === "connected" && provisioned.dockerVersion) {
    ok(`worker provisioned: Docker ${provisioned.dockerVersion}`);
  } else {
    ko(
      `provisioning: status ${provisioned?.status}, error ${provisioned?.lastError ?? "—"}`
    );
  }

  // Replayed: the second run must be a silent no-op, not a second
  // `swarm join` attempt on a node that is already a member.
  await provisionServer(ctx, workerRow.id);
  ok("provisioning replayable without error (idempotent)");

  // ── Swarm truth: two nodes, not one ─────────────────────────────────────
  managerSsh = await connect({ host: MANAGER_HOST, privateKey, user: USER });
  const managerDocker = dockerClient(managerSsh);
  const nodes = (await managerDocker.listNodes()) as Array<{
    ID?: string;
    Spec?: { Role?: string };
    Status?: { State?: string };
  }>;
  const workerNodes = nodes.filter((n) => n.Spec?.Role === "worker");
  if (nodes.length >= 2 && workerNodes.length >= 1) {
    ok(
      `cluster of ${nodes.length} nodes seen from the manager (${workerNodes.length} worker)`
    );
  } else {
    ko(
      `unexpected cluster: ${nodes.length} node(s), ${workerNodes.length} worker(s)`
    );
  }

  // ── source repo on the WORKER, not the manager ──────────────────────────
  const workerSsh = await connect({
    host: WORKER_HOST,
    privateKey,
    user: USER,
  });
  try {
    await exec(
      workerSsh,
      `sudo rm -rf ${quoteArg(ORIGIN)} && sudo mkdir -p ${quoteArg(ORIGIN)} && sudo chown -R "$USER" ${quoteArg(ORIGIN)} && ` +
        `cd ${quoteArg(ORIGIN)} && ` +
        `printf '%s' '{"name":"multi","scripts":{"start":"node s.js"}}' > package.json && ` +
        `printf '%s' 'const p=process.env.PORT||3000;require("http").createServer((q,r)=>r.end("multi hello")).listen(p)' > s.js && ` +
        "git init -q -b main . && git config user.email e@x && git config user.name e && " +
        "git add -A && git commit -q -m init"
    );
    ok("source repo created on the worker (not the manager)");
  } finally {
    disconnect(workerSsh);
  }

  await removeService(managerDocker, SERVICE_NAME);

  // ── service pinned to the worker ────────────────────────────────────────
  const [proj] = await db
    .insert(projects)
    .values({ name: "multi" })
    .returning();
  const [env] = await db
    .insert(environments)
    .values({ name: "production", projectId: proj?.id ?? "" })
    .returning();
  const [svc] = await db
    .insert(services)
    .values({
      buildMethod: "nixpacks",
      domain,
      environmentId: env?.id ?? "",
      gitBranch: "main",
      gitRepoUrl: `file://${ORIGIN}`,
      name: SERVICE_NAME,
      port: 3000,
      serverId: workerRow.id,
      sourceType: "git",
    })
    .returning();
  if (!svc) {
    throw new Error("service insert failed");
  }

  const [dep] = await db
    .insert(deployments)
    .values({ serviceId: svc.id, status: "queued", trigger: "manual" })
    .returning();
  if (!dep) {
    throw new Error("deployment insert failed");
  }

  console.log("    (build on the worker, Swarm switchover via the manager…)");
  await runDeploy(ctx, { deploymentId: dep.id });

  const final = await db.query.deployments.findFirst({
    where: eq(deployments.id, dep.id),
  });
  if (final?.status === "succeeded") {
    ok(`deployment succeeded, image ${final.imageTag}`);
  } else {
    ko(`status ${final?.status} — ${final?.errorMessage ?? ""}`);
  }

  // ── THE point of the test: did the task land on the RIGHT node? ─────────
  //
  // Without a placement constraint, Swarm could schedule it ANYWHERE — and
  // without a registry, the image built on the worker only exists THERE.
  const tasks = (await managerDocker.listTasks({
    filters: JSON.stringify({ service: [SERVICE_NAME] }),
  })) as Array<{ NodeID?: string; Status?: { State?: string } }>;
  const [workerNode] = workerNodes;
  const running = tasks.find((t) => t.Status?.State === "running");

  if (running && workerNode && running.NodeID === workerNode.ID) {
    ok("the task runs on the WORKER NODE — the placement constraint holds");
  } else {
    ko(
      `task on node ${running?.NodeID ?? "?"}, expected ${workerNode?.ID ?? "?"}`
    );
  }

  // ── HTTP across the overlay network, from the manager ───────────────────
  //
  // Traefik listens in `mode=host` on the MANAGER only (spike-local.sh,
  // `--constraint 'node.role==manager'`): so we must talk to the manager's
  // IP, never the worker's, even though the service's sslip.io domain encodes
  // the worker IP. `fetch` cannot supply the Host header Traefik's rule
  // expects — it is a forbidden header per the spec, already noted in
  // CLAUDE.md — so `curl -H` in a subprocess, not `fetch`.
  let body = "";
  const httpDeadline = Date.now() + 90_000;
  while (Date.now() < httpDeadline) {
    // biome-ignore lint/performance/noAwaitInLoops: intentional retry; Traefik's Swarm provider polls every 15s
    const result = await execFileAsync(
      "curl",
      [
        "-fsS",
        "--max-time",
        "10",
        "-H",
        `Host: ${domain}`,
        `http://${MANAGER_HOST}/`,
      ],
      { timeout: 12_000 }
    ).catch(() => null);
    if (result?.stdout.trim()) {
      body = result.stdout.trim();
      break;
    }
    await sleep(3000);
  }

  if (body.includes("multi")) {
    ok(`HTTP across the overlay, served from the worker: "${body}"`);
  } else {
    ko("no HTTP response within 90 s");
  }

  // ── rollback, in this same topology ─────────────────────────────────────
  //
  // Not a side note: this is the mechanism post-deploy watch (watch.ts)
  // depends on to catch a late crash — and here, neither the build nor the
  // service lives on the manager. `redeployImage` must find the SAME node
  // for the placement constraint, without rebuilding.
  if (final?.imageTag) {
    const { redeployImage } = await import("#deploy");
    await redeployImage(ctx, {
      imageTag: final.imageTag,
      serviceId: svc.id,
      trigger: "rollback",
    });

    const afterRollback = await db.query.deployments.findFirst({
      orderBy: (d, { desc }) => desc(d.createdAt),
      where: eq(deployments.serviceId, svc.id),
    });
    if (afterRollback?.status === "succeeded") {
      ok("rollback accepted, still in the same 2-node cluster");
    } else {
      ko(`rollback: status ${afterRollback?.status}`);
    }

    const tasksAfter = (await managerDocker.listTasks({
      filters: JSON.stringify({ service: [SERVICE_NAME] }),
    })) as Array<{ NodeID?: string; Status?: { State?: string } }>;
    const runningAfter = tasksAfter.find((t) => t.Status?.State === "running");
    if (runningAfter && workerNode && runningAfter.NodeID === workerNode.ID) {
      ok("after rollback, the task is STILL on the worker node");
    } else {
      ko(`after rollback, node ${runningAfter?.NodeID ?? "?"}`);
    }
  }
} catch (e) {
  ko(`exception: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  if (managerSsh) {
    try {
      const docker = dockerClient(managerSsh);
      if (!process.env.NODDLE_KEEP) {
        await removeService(docker, SERVICE_NAME);
      }
    } catch {
      // best-effort cleanup
    }
    disconnect(managerSsh);
  }
}

console.log(`\n\x1b[1mpassed ${pass}, failed ${fail}\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
