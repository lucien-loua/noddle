// Compose deployment: a real VM, two services in the SAME file — one built
// (`build:`), one taken as-is (`image:`) — to prove both of compose.ts's
// paths against reality, not only against the typecheck. Multi-node
// placement is already proven by verify-multi.ts; the question here is:
// does `docker stack deploy` do what compose.ts asks it to do, and does
// rollback really replay a past version without touching the repo?
//
//   STACK_HOST=192.168.252.3 DATABASE_URL=… node apps/worker/src/verify-stack.ts
//
// The manager must ALREADY be in Swarm (any VM used for a Phase 0/1/2 test
// already is).
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { createDatabase } from "@noddle/db";
import {
  environments,
  projects,
  servers,
  stackDeployments,
  stacks,
} from "@noddle/db/schema";
import { newStackSwarmName } from "@noddle/shared/swarm-names";
import { connect, disconnect, dockerClient, exec } from "@noddle/ssh-executor";
import { removeService } from "@noddle/swarm-ops";
import { eq, inArray } from "drizzle-orm";
import { redeployStack, runStackDeploy } from "#compose";
import { seedSshKey } from "#verify-seed";

const execFileAsync = promisify(execFile);

const DB_URL =
  process.env.DATABASE_URL ??
  "postgres://postgres:noddle@localhost:55432/noddle";
const STACK_HOST = process.env.STACK_HOST ?? "192.168.252.3";
const USER = process.env.TARGET_USER ?? "ubuntu";
const KEY = process.env.SSH_KEY ?? join(homedir(), ".ssh", "id_ed25519");

const STACK_NAME = "noddle-stack-probe";
const ORIGIN = "/opt/noddle-stack-origin";
const domain = `${STACK_NAME}.${STACK_HOST.replaceAll(".", "-")}.sslip.io`;

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
const sshKeyId = await seedSshKey(db, appKey, "verify-stack", privateKey);

let managerSsh: Awaited<ReturnType<typeof connect>> | undefined;

/** The stack's real Swarm name, known only once the row is created. */
let swarmName = "";

// Replayable: same principle as the other verify.ts scripts, the unique
// index (host, port, user) would otherwise collide with a previous run.
await db.delete(stackDeployments);
await db.delete(stacks);
await db.delete(environments);
await db.delete(projects);
await db.delete(servers).where(inArray(servers.host, [STACK_HOST]));

const COMPOSE_CONTENT = `
services:
  web:
    build: ./web
    ports: []
  redis:
    image: redis:7-alpine
`;

const writeOrigin = async (
  ssh: Awaited<ReturnType<typeof connect>>,
  indexBody: string,
  message: string
) => {
  await exec(
    ssh,
    `mkdir -p ${ORIGIN}/web && cd ${ORIGIN} && ` +
      `cat > docker-compose.yml <<'EOF'\n${COMPOSE_CONTENT}\nEOF\n` +
      `cat > web/Dockerfile <<'EOF'\n` +
      "FROM python:3-alpine\nRUN apk add --no-cache curl\nWORKDIR /site\nCOPY index.html .\n" +
      'CMD ["python3", "-m", "http.server", "3000"]\n' +
      "EOF\n" +
      `printf '%s' ${JSON.stringify(indexBody)} > web/index.html && ` +
      "git init -q -b main . 2>/dev/null; git config user.email e@x && git config user.name e && " +
      `git add -A && git commit -q -m ${JSON.stringify(message)} --allow-empty`
  );
};

try {
  const [server] = await db
    .insert(servers)
    .values({
      host: STACK_HOST,
      name: "stack-probe-manager",
      role: "manager",
      sshKeyId,
      sshUser: USER,
      status: "connected",
      totalMemoryMb: 2048,
    })
    .returning();
  if (!server) {
    throw new Error("server insertion failed");
  }
  ok("server registered");

  const ctx = {
    appKey,
    db,
    logRoot: "/tmp/noddle-stack-logs",
    networkName: "noddle-public",
  };

  managerSsh = await connect({ host: STACK_HOST, privateKey, user: USER });
  // By PREFIX, never by exact name: a stack's Swarm name now carries 8 hex
  // digits drawn from its id, so it changes on every run. An exact name
  // would leave an orphan behind on every interrupted run. Also covers the
  // LEGACY form (`<name>_<key>`), to sweep up what a run predating this fix
  // would have left behind.
  {
    const docker = dockerClient(managerSsh);
    const leftovers = await docker.listServices();
    for (const svc of leftovers) {
      const name = svc.Spec?.Name;
      if (name?.startsWith(STACK_NAME)) {
        // biome-ignore lint/performance/noAwaitInLoops: intentional sequential cleanup
        await removeService(docker, name);
      }
    }
  }

  await exec(
    managerSsh,
    `sudo rm -rf ${ORIGIN} && sudo mkdir -p ${ORIGIN} && sudo chown -R "$USER" ${ORIGIN}`
  );
  await writeOrigin(managerSsh, "compose bonjour un", "v1");
  ok("compose repo created (build: web, image: redis)");

  const [proj] = await db
    .insert(projects)
    .values({ name: "stack-probe" })
    .returning();
  const [env] = await db
    .insert(environments)
    .values({ name: "production", projectId: proj?.id ?? "" })
    .returning();
  const [stack] = await db
    .insert(stacks)
    .values({
      domain,
      environmentId: env?.id ?? "",
      gitBranch: "main",
      gitRepoUrl: `file://${ORIGIN}`,
      name: STACK_NAME,
      port: 3000,
      publicService: "web",
      serverId: server.id,
      swarmName: "placeholder",
    })
    .returning();
  if (!stack) {
    throw new Error("stack insertion failed");
  }
  // The NEW name, exactly as `connectStack` writes it — not the display
  // name. Without this, this bench would only exercise backfilled stacks,
  // where `swarmName === name`, and the new path would remain proven by
  // the typecheck alone.
  swarmName = newStackSwarmName(stack);
  await db.update(stacks).set({ swarmName }).where(eq(stacks.id, stack.id));
  stack.swarmName = swarmName;

  const [dep1] = await db
    .insert(stackDeployments)
    .values({ stackId: stack.id, status: "queued", trigger: "manual" })
    .returning();
  if (!dep1) {
    throw new Error("deployment insertion failed");
  }

  console.log("    (v1: build web, image redis, docker stack deploy…)");
  await runStackDeploy(ctx, { stackDeploymentId: dep1.id });

  const dep1Final = await db.query.stackDeployments.findFirst({
    where: eq(stackDeployments.id, dep1.id),
  });
  if (dep1Final?.status === "succeeded") {
    ok(
      `v1 succeeded — services built: ${JSON.stringify(dep1Final.serviceImages)}`
    );
  } else {
    ko(`v1: status ${dep1Final?.status} — ${dep1Final?.errorMessage ?? ""}`);
  }

  const builtOnlyWeb =
    dep1Final?.serviceImages &&
    Object.keys(dep1Final.serviceImages).length === 1 &&
    "web" in dep1Final.serviceImages;
  if (builtOnlyWeb) {
    ok("redis was NOT built — it only has `image:`, not `build:`");
  } else {
    ko(`unexpected serviceImages: ${JSON.stringify(dep1Final?.serviceImages)}`);
  }

  if (dep1Final?.composeSource?.includes("build: ./web")) {
    ok(
      "the stored composeSource is the text BEFORE rewriting (build: still present)"
    );
  } else {
    ko("composeSource doesn't contain the original build:");
  }

  const managerDocker = dockerClient(managerSsh);
  const webSvc = (
    await managerDocker.listServices({
      filters: JSON.stringify({ name: [`${swarmName}_web`] }),
    })
  ).find((s) => s.Spec?.Name === `${swarmName}_web`);
  const redisSvc = (
    await managerDocker.listServices({
      filters: JSON.stringify({ name: [`${swarmName}_redis`] }),
    })
  ).find((s) => s.Spec?.Name === `${swarmName}_redis`);
  if (webSvc && redisSvc) {
    ok("both Swarm services exist (web AND redis)");
  } else {
    ko(`missing services — web=${Boolean(webSvc)} redis=${Boolean(redisSvc)}`);
  }

  // ── HTTP through Traefik ────────────────────────────────────────────────────
  const httpOnce = async (): Promise<string> => {
    let body = "";
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      // biome-ignore lint/performance/noAwaitInLoops: intentional retry, Traefik's Swarm provider polls every 15s
      const result = await execFileAsync(
        "curl",
        [
          "-fsS",
          "--max-time",
          "10",
          "-H",
          `Host: ${domain}`,
          `http://${STACK_HOST}/`,
        ],
        { timeout: 12_000 }
      ).catch(() => null);
      if (result?.stdout.trim()) {
        body = result.stdout.trim();
        break;
      }
      await sleep(3000);
    }
    return body;
  };

  const body1 = await httpOnce();
  if (body1.includes("compose bonjour un")) {
    ok(`HTTP v1 via Traefik: "${body1}"`);
  } else {
    ko(`no v1 within 90s (received: "${body1}")`);
  }

  // ── v2: new content, new deployment ────────────────────────────────────────
  await writeOrigin(managerSsh, "compose bonjour deux", "v2");
  const [dep2] = await db
    .insert(stackDeployments)
    .values({ stackId: stack.id, status: "queued", trigger: "manual" })
    .returning();
  if (!dep2) {
    throw new Error("v2 deployment insertion failed");
  }
  console.log("    (v2: new content…)");
  await runStackDeploy(ctx, { stackDeploymentId: dep2.id });

  const body2 = await httpOnce();
  if (body2.includes("compose bonjour deux")) {
    ok(`HTTP v2 via Traefik: "${body2}"`);
  } else {
    ko(`no v2 within 90s (received: "${body2}")`);
  }

  // ── rollback to v1, WITHOUT repo or build ──────────────────────────────────
  console.log("    (rollback to v1 — replays stored composeSource + tags…)");
  const rollbackId = await redeployStack(ctx, {
    sourceDeploymentId: dep1.id,
    stackId: stack.id,
    trigger: "rollback",
  });
  const rollbackFinal = await db.query.stackDeployments.findFirst({
    where: eq(stackDeployments.id, rollbackId),
  });
  if (rollbackFinal?.status === "succeeded") {
    ok("rollback accepted");
  } else {
    ko(`rollback: status ${rollbackFinal?.status}`);
  }

  const body3 = await httpOnce();
  if (body3.includes("compose bonjour un")) {
    ok(`HTTP after rollback: back to v1 — "${body3}"`);
  } else {
    ko(`after rollback, expected v1, received "${body3}"`);
  }
} catch (e) {
  ko(`exception: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  if (managerSsh) {
    try {
      const docker = dockerClient(managerSsh);
      if (!process.env.NODDLE_KEEP) {
        await removeService(docker, `${swarmName}_web`);
        await removeService(docker, `${swarmName}_redis`);
      }
    } catch {
      // best-effort cleanup
    }
    disconnect(managerSsh);
  }
}

console.log(`\n\x1b[1mpassed ${pass}, failed ${fail}\x1b[0m\n`);

// A bench that doesn't return an exit code can't be chained: a RED run would
// be indistinguishable from a green one to the caller. And without an
// explicit exit, the Postgres pool keeps the event loop alive, so the process
// never terminates — measured, the last two runs stayed alive after printing
// their result. The same lesson as `execArgv`'s exit code, which nothing
// forced anyone to read.
process.exit(fail === 0 ? 0 : 1);
