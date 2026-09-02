// tier: vm
import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
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
import { removeService } from "@noddle/deploy-engine/ops";
import {
  connect,
  disconnect,
  dockerClient,
  exec,
  quoteArg,
} from "@noddle/ssh-executor";
import { devStack } from "@noddle/testing/dev-stack";
import { devTarget } from "@noddle/testing/dev-target";
import { desc, eq } from "drizzle-orm";

import { runDeploy } from "#deploy";
import type { BuildOptions, RouteOptions } from "#runtime-context";
import { sweepWatch } from "#sweep";
import { seedSshKey, verifyCtx } from "#verify-seed";

const DB_URL = devStack().databaseUrl;
const TARGET = devTarget();

const SERVICE_NAME = "noddle-watch";
const ORIGIN = "/opt/noddle-watch-origin";

const CRASH_AFTER_S = 70;

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
const step = (m: string) => console.log(`    ${m}`);

const appKey = randomBytes(32);
const db = createDatabase({ url: DB_URL });
const { privateKey } = TARGET;
const sshKeyId = await seedSshKey(db, appKey, "verify-watch", privateKey);

let ssh: Awaited<ReturnType<typeof connect>> | undefined;

async function writeApp(
  client: Awaited<ReturnType<typeof connect>>,
  body: string,
  message: string
): Promise<void> {
  await exec(
    client,
    `cd ${quoteArg(ORIGIN)} && printf '%s' ${quoteArg(body)} > s.js && ` +
      `git add -A && git commit -q -m ${quoteArg(message)}`
  );
}

try {
  ssh = await connect({ host: TARGET.host, privateKey, user: TARGET.user });
  const docker = dockerClient(ssh);
  await removeService(docker, SERVICE_NAME);

  await exec(
    ssh,
    `sudo rm -rf ${quoteArg(ORIGIN)} && sudo mkdir -p ${quoteArg(ORIGIN)} && sudo chown -R "$USER" ${quoteArg(ORIGIN)} && ` +
      `cd ${quoteArg(ORIGIN)} && printf '%s' '{"name":"w","scripts":{"start":"node s.js"}}' > package.json && ` +
      "git init -q -b main . && git config user.email w@x && git config user.name w"
  );
  await writeApp(
    ssh,
    'const p=process.env.PORT||3000;require("http").createServer((q,r)=>r.end("SAINE")).listen(p)',
    "v1 saine"
  );
  ok("repo created, healthy version committed");

  const [srv] = await db
    .insert(servers)
    .values({
      host: TARGET.host,
      name: "watch-target",
      role: "manager",
      sshKeyId,
      sshUser: TARGET.user,
      totalMemoryMb: 2048,
    })
    .returning();

  const [proj] = await db
    .insert(projects)
    .values({ name: "watch" })
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
      gitRepoUrl: `file://${ORIGIN}`,
      name: SERVICE_NAME,
      port: 3000,
      serverId: srv?.id ?? "",
      sourceType: "git",
    })
    .returning();
  if (svc) {
    await db.insert(serviceDomains).values({
      host: `${SERVICE_NAME}.${TARGET.host.replaceAll(".", "-")}.sslip.io`,
      serviceId: svc.id,
    });
  }

  const logRoot = await mkdtemp(join(tmpdir(), "noddle-watch-logs-"));
  const ctx = verifyCtx({ appKey, db });
  const route: RouteOptions = { networkName: "noddle-public" };
  const build: BuildOptions = { logRoot };

  step("deploying the healthy version (build, a few minutes)…");
  const [d1] = await db
    .insert(deployments)
    .values({ serviceId: svc?.id ?? "", status: "queued", trigger: "manual" })
    .returning();
  await runDeploy(ctx, route, build, { deploymentId: d1?.id ?? "" });

  const dep1 = await db.query.deployments.findFirst({
    where: eq(deployments.id, d1?.id ?? ""),
  });
  if (dep1?.status === "succeeded" && dep1.imageTag) {
    ok(`v1 deployed: ${dep1.imageTag}`);
  } else {
    throw new Error(`v1 failed: ${dep1?.status} ${dep1?.errorMessage}`);
  }

  await writeApp(
    ssh,
    `const p=process.env.PORT||3000;require("http").createServer((q,r)=>r.end("CASSEE")).listen(p);setTimeout(()=>process.exit(1),${CRASH_AFTER_S * 1000})`,
    "v2 crash tardif"
  );
  step(`deploying the version that dies at ${CRASH_AFTER_S}s…`);

  const [d2] = await db
    .insert(deployments)
    .values({ serviceId: svc?.id ?? "", status: "queued", trigger: "manual" })
    .returning();
  await runDeploy(ctx, route, build, { deploymentId: d2?.id ?? "" });

  const dep2 = await db.query.deployments.findFirst({
    where: eq(deployments.id, d2?.id ?? ""),
  });

  if (dep2?.status === "succeeded") {
    ok("v2 reported successful by Swarm — the crash hasn't happened yet");
  } else {
    ko(`v2 expected succeeded, got ${dep2?.status} (${dep2?.errorMessage})`);
  }
  if (dep2?.watchUntil && dep2.watchUntil > new Date()) {
    ok("monitoring armed: it's all that's left between the app and the loop");
  } else {
    ko("watchUntil missing — nothing would catch the crash");
  }

  step("waiting for the crash loop then monitoring passes…");
  const deadline = Date.now() + 6 * 60 * 1000;
  let reverted = false;

  while (Date.now() < deadline && !reverted) {
    await sleep(20_000);
    const result = await sweepWatch(ctx, route);
    if (result.reverted.length > 0) {
      reverted = true;
      ok("monitoring: loop detected and revert triggered");
    } else if (result.strandedServices.length > 0) {
      ko("detected but no earlier version found");
      break;
    }
  }
  if (!reverted) {
    ko("the loop wasn't detected within 6 minutes");
  }

  const dep2After = await db.query.deployments.findFirst({
    where: eq(deployments.id, d2?.id ?? ""),
  });
  if (dep2After?.status === "reverted_by_watch") {
    ok("v2 marked reverted_by_watch — distinct from a Swarm rolled_back");
  } else {
    ko(`expected status reverted_by_watch, got ${dep2After?.status}`);
  }

  const latest = await db.query.deployments.findFirst({
    orderBy: desc(deployments.createdAt),
    where: eq(deployments.serviceId, svc?.id ?? ""),
  });
  if (
    latest?.trigger === "watch_revert" &&
    latest.imageTag === dep1?.imageTag
  ) {
    ok(`v1's image replayed from history: ${latest.imageTag}`);
  } else {
    ko(`unexpected revert: ${latest?.trigger} / ${latest?.imageTag}`);
  }

  const domain = `${SERVICE_NAME}.${TARGET.host.replaceAll(".", "-")}.sslip.io`;
  let body = "";
  const httpDeadline = Date.now() + 90_000;
  while (Date.now() < httpDeadline) {
    const res = await fetch(`http://${domain}/`, {
      signal: AbortSignal.timeout(8000),
    }).catch(() => null);
    if (res?.ok) {
      body = (await res.text()).trim();
      if (body === "SAINE") {
        break;
      }
    }
    await sleep(3000);
  }
  if (body === "SAINE") {
    ok("the service serves the healthy version again — the loop is over");
  } else {
    ko(`the service serves "${body || "nothing"}" instead of SAINE`);
  }
} catch (error) {
  ko(`exception: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  if (ssh) {
    try {
      if (!process.env.NODDLE_KEEP) {
        await removeService(dockerClient(ssh), SERVICE_NAME);
        await exec(ssh, `sudo rm -rf ${quoteArg(ORIGIN)}`);
      }
    } catch {}
    disconnect(ssh);
  }
}

console.log(`\n[1mpassed ${pass}, failed ${fail}[0m\n`);
process.exit(fail === 0 ? 0 : 1);
