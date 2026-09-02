// tier: vm
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

import { createDatabase } from "@noddle/db";
import {
  deployments,
  environments,
  projects,
  servers,
  serviceDomains,
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
import { devStack } from "@noddle/testing/dev-stack";
import { devTarget } from "@noddle/testing/dev-target";
import { eq, inArray } from "drizzle-orm";

import { runDeploy } from "#deploy";
import { provisionServer } from "#provision";
import { seedSshKey, verifyCtx } from "#verify-seed";

const MANAGER = devTarget();
const WORKER = devTarget("noddle-target-2");

const execFileAsync = promisify(execFile);

const DB_URL = devStack().databaseUrl;

const SERVICE_NAME = "noddle-multi";
const ORIGIN = "/opt/noddle-multi-origin";

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

const appKey = randomBytes(32);
const db = createDatabase({ url: DB_URL });
const { privateKey } = MANAGER;
const sshKeyId = await seedSshKey(db, appKey, "verify-multi", privateKey);
const domain = `${SERVICE_NAME}.${WORKER.host.replaceAll(".", "-")}.sslip.io`;

let managerSsh: Awaited<ReturnType<typeof connect>> | undefined;

await db.delete(deployments);
await db.delete(services);
await db.delete(environments);
await db.delete(projects);
await db
  .delete(servers)
  .where(inArray(servers.host, [MANAGER.host, WORKER.host]));

try {
  const [managerRow] = await db
    .insert(servers)
    .values({
      host: MANAGER.host,
      name: "multi-manager",
      role: "manager",
      sshKeyId,
      sshUser: MANAGER.user,
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
      host: WORKER.host,
      name: "multi-worker",
      sshKeyId,
      sshUser: MANAGER.user,
    })
    .returning();
  if (!workerRow) {
    throw new Error("worker insert failed");
  }
  ok("worker registered, pending (status=pending)");

  const ctx = verifyCtx({ appKey, db });
  const route = { networkName: "noddle-public" };
  const build = { logRoot: "/tmp/noddle-multi-logs" };

  console.log("    (provisioning the worker — Docker, join, railpack…)");
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

  await provisionServer(ctx, workerRow.id);
  ok("provisioning replayable without error (idempotent)");

  managerSsh = await connect({
    host: MANAGER.host,
    privateKey,
    user: MANAGER.user,
  });
  const managerDocker = dockerClient(managerSsh);
  const nodes = (await managerDocker.listNodes()) as {
    ID?: string;
    Spec?: { Role?: string };
    Status?: { State?: string };
  }[];
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

  const workerSsh = await connect({
    host: WORKER.host,
    privateKey,
    user: MANAGER.user,
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
      buildMethod: "railpack",
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
  await db.insert(serviceDomains).values({ host: domain, serviceId: svc.id });

  const [dep] = await db
    .insert(deployments)
    .values({ serviceId: svc.id, status: "queued", trigger: "manual" })
    .returning();
  if (!dep) {
    throw new Error("deployment insert failed");
  }

  console.log("    (build on the worker, Swarm switchover via the manager…)");
  await runDeploy(ctx, route, build, { deploymentId: dep.id });

  const final = await db.query.deployments.findFirst({
    where: eq(deployments.id, dep.id),
  });
  if (final?.status === "succeeded") {
    ok(`deployment succeeded, image ${final.imageTag}`);
  } else {
    ko(`status ${final?.status} — ${final?.errorMessage ?? ""}`);
  }

  const tasks = (await managerDocker.listTasks({
    filters: JSON.stringify({ service: [SERVICE_NAME] }),
  })) as { NodeID?: string; Status?: { State?: string } }[];
  const [workerNode] = workerNodes;
  const running = tasks.find((t) => t.Status?.State === "running");

  if (running && workerNode && running.NodeID === workerNode.ID) {
    ok("the task runs on the WORKER NODE — the placement constraint holds");
  } else {
    ko(
      `task on node ${running?.NodeID ?? "?"}, expected ${workerNode?.ID ?? "?"}`
    );
  }

  let body = "";
  const httpDeadline = Date.now() + 90_000;
  while (Date.now() < httpDeadline) {
    const result = await execFileAsync(
      "curl",
      [
        "-fsS",
        "--max-time",
        "10",
        "-H",
        `Host: ${domain}`,
        `http://${MANAGER.host}/`,
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

  if (final?.imageTag) {
    const { redeployImage } = await import("#deploy");
    await redeployImage(ctx, route, {
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
    })) as { NodeID?: string; Status?: { State?: string } }[];
    const runningAfter = tasksAfter.find((t) => t.Status?.State === "running");
    if (runningAfter && workerNode && runningAfter.NodeID === workerNode.ID) {
      ok("after rollback, the task is STILL on the worker node");
    } else {
      ko(`after rollback, node ${runningAfter?.NodeID ?? "?"}`);
    }
  }
} catch (error) {
  ko(`exception: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  if (managerSsh) {
    try {
      const docker = dockerClient(managerSsh);
      if (!process.env.NODDLE_KEEP) {
        await removeService(docker, SERVICE_NAME);
      }
    } catch {}
    disconnect(managerSsh);
  }
}

console.log(`\n\u001B[1mpassed ${pass}, failed ${fail}\u001B[0m\n`);
process.exit(fail === 0 ? 0 : 1);
