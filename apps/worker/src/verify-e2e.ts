// DATABASE_URL=… node apps/worker/src/verify-e2e.ts
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "@noddle/db";
import {
  deploymentLogs,
  deployments,
  environments,
  envVars,
  projects,
  servers,
  services,
} from "@noddle/db/schema";
import { encryptSecret, secretContext } from "@noddle/shared/crypto";
import { connect, disconnect, exec, quoteArg } from "@noddle/ssh-executor";
import { eq } from "drizzle-orm";
import { runDeploy } from "#deploy";
import { removeService } from "#swarm";
import { seedSshKey } from "#verify-seed";

const DB_URL =
  process.env.DATABASE_URL ??
  "postgres://postgres:noddle@localhost:55432/noddle";
const HOST = process.env.TARGET_HOST ?? "192.168.252.3";
const USER = process.env.TARGET_USER ?? "ubuntu";
const KEY = process.env.SSH_KEY ?? join(homedir(), ".ssh", "id_ed25519");

const SERVICE_NAME = "noddle-e2e";
const ORIGIN = "/opt/noddle-e2e-origin";

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

const appKey = randomBytes(32);
const db = createDatabase({ url: DB_URL });
const privateKey = readFileSync(KEY, "utf8");
const sshKeyId = await seedSshKey(db, appKey, "verify-e2e", privateKey);
const domain = `${SERVICE_NAME}.${HOST.replaceAll(".", "-")}.sslip.io`;

let ssh: Awaited<ReturnType<typeof connect>> | undefined;

try {
  ssh = await connect({ host: HOST, privateKey, user: USER });

  // Source repo on the target. `file://` is an inert transport, allowed by the
  // allowlist; `ext::` is not — and that is the point.
  await exec(
    ssh,
    `sudo rm -rf ${quoteArg(ORIGIN)} && sudo mkdir -p ${quoteArg(ORIGIN)} && sudo chown -R "$USER" ${quoteArg(ORIGIN)} && ` +
      `cd ${quoteArg(ORIGIN)} && ` +
      `printf '%s' '{"name":"e2e","scripts":{"start":"node s.js"}}' > package.json && ` +
      `printf '%s' 'const p=process.env.PORT||3000;require("http").createServer((q,r)=>r.end("e2e "+(process.env.GREETING||"?"))).listen(p)' > s.js && ` +
      "git init -q -b main . && git config user.email e@x && git config user.name e && " +
      "git add -A && git commit -q -m init"
  );
  ok("source repo created on the target");

  // ── seed ────────────────────────────────────────────────────────────────
  const [srv] = await db
    .insert(servers)
    .values({
      host: HOST,
      isSelf: false,
      name: "e2e-target",
      // `role: "manager"`: this bench depended on it without declaring it. It
      // passed because a manager lingered in the DB, left by host adoption or
      // another script — and it failed with "no Swarm manager registered" as
      // soon as a neighboring `reset()` deleted it. Staging that blamed the
      // code — the same trap already noted for `connectForDeploy`. On a
      // development machine, the target IS the manager, which is what
      // `adopt-host` writes in production.
      role: "manager",
      sshKeyId,
      sshUser: USER,
      totalMemoryMb: 2048,
    })
    .returning();
  if (!srv) {
    throw new Error("server insert failed");
  }
  ok("server registered, SSH key encrypted with AAD binding");

  const [proj] = await db.insert(projects).values({ name: "e2e" }).returning();
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
      serverId: srv.id,
      sourceType: "git",
    })
    .returning();
  if (!svc) {
    throw new Error("service insert failed");
  }

  const [ev] = await db
    .insert(envVars)
    .values({
      isSecret: false,
      key: "GREETING",
      serviceId: svc.id,
      valueEncrypted: "placeholder",
    })
    .returning();
  await db
    .update(envVars)
    .set({
      valueEncrypted: encryptSecret(
        "hello",
        appKey,
        secretContext.envVar(ev?.id ?? "")
      ),
    })
    .where(eq(envVars.id, ev?.id ?? ""));
  ok("service and encrypted environment variable registered");

  await removeService(
    (await import("@noddle/ssh-executor")).dockerClient(ssh),
    SERVICE_NAME
  );

  // ── deploy ──────────────────────────────────────────────────────────────
  const [dep] = await db
    .insert(deployments)
    .values({ serviceId: svc.id, status: "queued", trigger: "manual" })
    .returning();
  if (!dep) {
    throw new Error("deployment insert failed");
  }

  const logDir = await mkdtemp(join(tmpdir(), "noddle-e2e-logs-"));
  let streamed = 0;
  console.log(
    "    (clone, capped build, and Swarm switchover — a few minutes…)"
  );

  await runDeploy(
    {
      appKey,
      db,
      logRoot: logDir,
      networkName: "noddle-public",
      onLog: () => {
        streamed += 1;
      },
    },
    { deploymentId: dep.id }
  );

  // ── assertions ──────────────────────────────────────────────────────────
  const final = await db.query.deployments.findFirst({
    where: eq(deployments.id, dep.id),
  });

  if (final?.status === "succeeded") {
    ok(`deployment succeeded, swarm=${final.swarmUpdateState ?? "create"}`);
  } else {
    ko(`status ${final?.status} — ${final?.errorMessage ?? ""}`);
  }
  if (final?.commitSha && /^[0-9a-f]{40}$/.test(final.commitSha)) {
    ok(`SHA resolved and persisted: ${final.commitSha.slice(0, 8)}`);
  } else {
    ko("SHA not persisted");
  }
  if (final?.imageTag) {
    ok(`image built: ${final.imageTag}`);
  } else {
    ko("no image tag");
  }
  if (final?.watchUntil && final.watchUntil > new Date()) {
    ok("post-deploy watch armed");
  } else {
    ko("watchUntil missing: late crashes would not be caught");
  }
  if (streamed > 0) {
    ok(`${streamed} log fragments streamed to SSE`);
  } else {
    ko("no logs streamed");
  }

  const logs = await db.query.deploymentLogs.findMany({
    where: eq(deploymentLogs.deploymentId, dep.id),
  });
  const [row] = logs;
  if (logs.length === 1 && row && row.byteSize > 0) {
    ok(`logs: 1 DB row, pointer to ${row.byteSize} bytes on disk`);
  } else {
    ko(`expected exactly 1 log pointer, got ${logs.length}`);
  }

  const svcAfter = await db.query.services.findFirst({
    where: eq(services.id, svc.id),
  });
  if (
    svcAfter?.status === "running" &&
    svcAfter.currentDeploymentId === dep.id
  ) {
    ok("service marked running and pointing at this deployment");
  } else {
    ko(`unexpected service state: ${svcAfter?.status}`);
  }

  // ── THE proof: the service actually responds ────────────────────────────
  // Via the domain, NOT via a Host header: `Host` is a forbidden header for
  // fetch, silently ignored. sslip.io resolves the domain to the IP it
  // encodes, so the URL alone is enough.
  //
  // And we retry: Traefik's Swarm provider only polls every 15 s by default.
  // A converged task is therefore NOT immediately reachable — a product fact,
  // not a test artifact. On a first deploy, "deployed" and "reachable" are
  // separated by that window.
  let body = "";
  const httpDeadline = Date.now() + 90_000;
  while (Date.now() < httpDeadline) {
    // Intentional retry: Traefik's Swarm provider only polls every 15 s, so a
    // converged task is not yet reachable.
    // biome-ignore lint/performance/noAwaitInLoops: intentional retry
    const res = await fetch(`http://${domain}/`, {
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    if (res?.ok) {
      body = (await res.text()).trim();
      break;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }

  if (body.includes("e2e")) {
    ok(`HTTP via Traefik: "${body}"`);
  } else {
    ko("no response via Traefik within 90 s");
  }
  if (body.includes("hello")) {
    ok("the encrypted variable was decrypted and injected into the container");
  } else {
    ko("environment variable missing from the container");
  }
} catch (e) {
  ko(`exception: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  if (ssh) {
    try {
      // NODDLE_KEEP=1 leaves the service in place for inspection.
      const { dockerClient } = await import("@noddle/ssh-executor");
      if (!process.env.NODDLE_KEEP) {
        await removeService(dockerClient(ssh), SERVICE_NAME);
      }
      await exec(ssh, `sudo rm -rf ${quoteArg(ORIGIN)}`);
    } catch {
      // best-effort cleanup
    }
    disconnect(ssh);
  }
}

console.log(`\n[1mpassed ${pass}, failed ${fail}[0m\n`);
process.exit(fail === 0 ? 0 : 1);
