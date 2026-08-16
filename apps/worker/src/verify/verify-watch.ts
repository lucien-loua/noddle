// tier: vm
// Verifies post-deployment monitoring against a REAL service that crash loops.
//
// The scenario is the one measured in Phase 0, the one Swarm doesn't catch:
// an application that converges, passes its healthcheck, lets the monitor
// window elapse — then dies. At that point the old task is drained, the
// update is already reported "completed", and the restart policy keeps
// relaunching the broken image indefinitely. Availability measured then: 9/12.
//
// This test fails if Noddle doesn't take back control.
//
//   DATABASE_URL=… node apps/worker/src/verify/verify-watch.ts
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
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
import { desc, eq } from "drizzle-orm";
import { runDeploy } from "#deploy";
import type { BuildOptions, RouteOptions } from "#runtime-context";
import { sweepWatch } from "#sweep";
import { seedSshKey, verifyCtx } from "#verify-seed";

const DB_URL = devStack().databaseUrl;
const HOST = process.env.TARGET_HOST ?? "192.168.252.3";
const USER = process.env.TARGET_USER ?? "ubuntu";
const KEY = process.env.SSH_KEY ?? join(homedir(), ".ssh", "id_ed25519");

const SERVICE_NAME = "noddle-watch";
const ORIGIN = "/opt/noddle-watch-origin";

// 70s: solidly past the 45s monitor window, with enough margin that the
// crash doesn't fall back into it by chance — in which case we'd be testing
// Swarm's rollback, not Noddle's monitoring.
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
const privateKey = readFileSync(KEY, "utf8");
const sshKeyId = await seedSshKey(db, appKey, "verify-watch", privateKey);

let ssh: Awaited<ReturnType<typeof connect>> | undefined;

async function writeApp(
  client: Awaited<ReturnType<typeof connect>>,
  body: string,
  message: string
): Promise<void> {
  // printf '%s': without it, printf interprets escape sequences and cuts
  // JavaScript literals in half.
  await exec(
    client,
    `cd ${quoteArg(ORIGIN)} && printf '%s' ${quoteArg(body)} > s.js && ` +
      `git add -A && git commit -q -m ${quoteArg(message)}`
  );
}

try {
  ssh = await connect({ host: HOST, privateKey, user: USER });
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

  // ── seed ────────────────────────────────────────────────────────────────
  const [srv] = await db
    .insert(servers)
    .values({
      host: HOST,
      name: "watch-target",
      role: "manager",
      sshKeyId,
      sshUser: USER,
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
      host: `${SERVICE_NAME}.${HOST.replaceAll(".", "-")}.sslip.io`,
      serviceId: svc.id,
    });
  }

  const logRoot = await mkdtemp(join(tmpdir(), "noddle-watch-logs-"));
  const ctx = verifyCtx({ appKey, db });
  const route: RouteOptions = { networkName: "noddle-public" };
  const build: BuildOptions = { logRoot };

  // ── deployment 1: healthy ───────────────────────────────────────────────
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

  // ── deployment 2: converges then dies OUTSIDE the window ────────────────
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

  // The crucial point: Swarm considers this deployment SUCCESSFUL. The
  // crash is still to come, outside its monitoring window.
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

  // ── the loop kicks in, then monitoring passes run ────────────────────────
  step("waiting for the crash loop then monitoring passes…");
  const deadline = Date.now() + 6 * 60 * 1000;
  let reverted = false;

  while (Date.now() < deadline && !reverted) {
    // biome-ignore lint/performance/noAwaitInLoops: intentional polling
    await new Promise((r) => setTimeout(r, 20_000));
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

  // ── final assertions ──────────────────────────────────────────────────────
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

  // ── the proof: the service serves the healthy version again ─────────────
  const domain = `${SERVICE_NAME}.${HOST.replaceAll(".", "-")}.sslip.io`;
  let body = "";
  const httpDeadline = Date.now() + 90_000;
  while (Date.now() < httpDeadline) {
    // biome-ignore lint/performance/noAwaitInLoops: intentional polling
    const res = await fetch(`http://${domain}/`, {
      signal: AbortSignal.timeout(8000),
    }).catch(() => null);
    if (res?.ok) {
      body = (await res.text()).trim();
      if (body === "SAINE") {
        break;
      }
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (body === "SAINE") {
    ok("the service serves the healthy version again — the loop is over");
  } else {
    ko(`the service serves "${body || "nothing"}" instead of SAINE`);
  }
} catch (e) {
  ko(`exception: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  if (ssh) {
    try {
      if (!process.env.NODDLE_KEEP) {
        await removeService(dockerClient(ssh), SERVICE_NAME);
        await exec(ssh, `sudo rm -rf ${quoteArg(ORIGIN)}`);
      }
    } catch {
      // best-effort cleanup
    }
    disconnect(ssh);
  }
}

console.log(`\n[1mpassed ${pass}, failed ${fail}[0m\n`);
process.exit(fail === 0 ? 0 : 1);
