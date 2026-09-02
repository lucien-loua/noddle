// tier: vm
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
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
import { removeService } from "@noddle/deploy-engine/ops";
import { newStackSwarmName } from "@noddle/shared/swarm-names";
import { connect, disconnect, dockerClient, exec } from "@noddle/ssh-executor";
import { devStack } from "@noddle/testing/dev-stack";
import { devTarget } from "@noddle/testing/dev-target";
import { eq, inArray } from "drizzle-orm";

import { redeployStack, runStackDeploy } from "#compose";
import { seedSshKey, verifyCtx } from "#verify-seed";

const TARGET = devTarget();

const execFileAsync = promisify(execFile);

const DB_URL = devStack().databaseUrl;

const STACK_NAME = "noddle-stack-probe";
const ORIGIN = "/opt/noddle-stack-origin";
const domain = `${STACK_NAME}.${TARGET.host.replaceAll(".", "-")}.sslip.io`;

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
const { privateKey } = TARGET;
const sshKeyId = await seedSshKey(db, appKey, "verify-stack", privateKey);

let managerSsh: Awaited<ReturnType<typeof connect>> | undefined;

let swarmName = "";

await db.delete(stackDeployments);
await db.delete(stacks);
await db.delete(environments);
await db.delete(projects);
await db.delete(servers).where(inArray(servers.host, [TARGET.host]));

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
      host: TARGET.host,
      name: "stack-probe-manager",
      role: "manager",
      sshKeyId,
      sshUser: TARGET.user,
      status: "connected",
      totalMemoryMb: 2048,
    })
    .returning();
  if (!server) {
    throw new Error("server insertion failed");
  }
  ok("server registered");

  const ctx = verifyCtx({ appKey, db });
  const route = { networkName: "noddle-public" };
  const build = { logRoot: "/tmp/noddle-stack-logs" };

  managerSsh = await connect({
    host: TARGET.host,
    privateKey,
    user: TARGET.user,
  });
  {
    const docker = dockerClient(managerSsh);
    const leftovers = await docker.listServices();
    for (const svc of leftovers) {
      const name = svc.Spec?.Name;
      if (name?.startsWith(STACK_NAME)) {
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
  await runStackDeploy(ctx, route, build, { stackDeploymentId: dep1.id });

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

  const httpOnce = async (): Promise<string> => {
    let body = "";
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const result = await execFileAsync(
        "curl",
        [
          "-fsS",
          "--max-time",
          "10",
          "-H",
          `Host: ${domain}`,
          `http://${TARGET.host}/`,
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

  await writeOrigin(managerSsh, "compose bonjour deux", "v2");
  const [dep2] = await db
    .insert(stackDeployments)
    .values({ stackId: stack.id, status: "queued", trigger: "manual" })
    .returning();
  if (!dep2) {
    throw new Error("v2 deployment insertion failed");
  }
  console.log("    (v2: new content…)");
  await runStackDeploy(ctx, route, build, { stackDeploymentId: dep2.id });

  const body2 = await httpOnce();
  if (body2.includes("compose bonjour deux")) {
    ok(`HTTP v2 via Traefik: "${body2}"`);
  } else {
    ko(`no v2 within 90s (received: "${body2}")`);
  }

  console.log("    (rollback to v1 — replays stored composeSource + tags…)");
  const rollbackId = await redeployStack(ctx, route, {
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
} catch (error) {
  ko(`exception: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  if (managerSsh) {
    try {
      const docker = dockerClient(managerSsh);
      if (!process.env.NODDLE_KEEP) {
        await removeService(docker, `${swarmName}_web`);
        await removeService(docker, `${swarmName}_redis`);
      }
    } catch {}
    disconnect(managerSsh);
  }
}

console.log(`\n\u001B[1mpassed ${pass}, failed ${fail}\u001B[0m\n`);

process.exit(fail === 0 ? 0 : 1);
