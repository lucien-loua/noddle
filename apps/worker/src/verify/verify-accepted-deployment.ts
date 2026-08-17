// tier: pure
// bun run apps/worker/src/verify/verify-accepted-deployment.ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { createDatabase } from "@noddle/db";
import {
  deployments,
  environments,
  projects,
  servers,
  services,
  sshKeys,
  stackDeployments,
  stacks,
} from "@noddle/db/schema";
import { WATCH_WINDOW_MS } from "@noddle/swarm-ops";
import { check, cleanup, runVerify, suite } from "@noddle/testing";
import { eq } from "drizzle-orm";

import { recordAcceptedService, recordAcceptedStack } from "#deploy/accepted-deployment";

const WORKER_SRC = join(import.meta.dirname, "..");
const NEXT_ASYNC_FUNCTION = /\n(?:export )?async function /;

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === "verify") {
      continue;
    }
    const path = join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...walkTs(path));
      continue;
    }
    if (ent.name.endsWith(".ts")) {
      out.push(path);
    }
  }
  return out;
}

function functionBody(src: string, name: string): string {
  const exportedAt = src.indexOf(`export async function ${name}`);
  const start = exportedAt === -1 ? src.indexOf(`async function ${name}`) : exportedAt;
  if (start === -1) {
    return "";
  }
  const rest = src.slice(start);
  const next = rest.slice(1).search(NEXT_ASYNC_FUNCTION);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

function armedWithinWindow(watchUntil: Date | null, finishedAt: Date): boolean {
  if (!watchUntil) {
    return false;
  }
  return Math.abs(watchUntil.getTime() - (finishedAt.getTime() + WATCH_WINDOW_MS)) < 1000;
}

await runVerify("accepted deployment (Post-deploy watch)", async () => {
  await suite("arming lives in one module", () => {
    const accepted = readFileSync(join(WORKER_SRC, "deploy/accepted-deployment.ts"), "utf-8");
    const deploy = readFileSync(join(WORKER_SRC, "deploy/deploy.ts"), "utf-8");
    const compose = readFileSync(join(WORKER_SRC, "deploy/compose.ts"), "utf-8");

    check(
      "accepted-deployment imports watchUntilFor",
      accepted.includes('import { watchUntilFor } from "@noddle/swarm-ops"'),
    );
    check("deploy.ts does not import watchUntilFor", !deploy.includes("watchUntilFor"));
    check("compose.ts does not import watchUntilFor", !compose.includes("watchUntilFor"));

    const armingFiles = walkTs(WORKER_SRC).filter((path) =>
      readFileSync(path, "utf-8").includes("watchUntilFor"),
    );
    const armingNames = armingFiles.map((path) => path.split("/").at(-1));
    check(
      "only accepted-deployment.ts arms watchUntilFor in the worker",
      armingNames.length === 1 && armingNames[0] === "accepted-deployment.ts",
    );

    check(
      "ship Service records via recordAcceptedService",
      functionBody(deploy, "buildAndDeployService").includes("recordAcceptedService"),
    );
    check(
      "Rollback / watch_revert Service records via recordAcceptedService",
      functionBody(deploy, "redeployImage").includes("recordAcceptedService"),
    );
    check(
      "ship Stack records via recordAcceptedStack",
      functionBody(compose, "buildAndDeployStack").includes("recordAcceptedStack"),
    );
    check(
      "Rollback / watch_revert Stack records via recordAcceptedStack",
      functionBody(compose, "redeployStack").includes("recordAcceptedStack"),
    );
  });

  const url = process.env.DATABASE_URL;
  if (!url) {
    return;
  }

  const db = createDatabase({ url });
  const tag = crypto.randomUUID();
  const keyId = crypto.randomUUID();
  const serverId = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  const environmentId = crypto.randomUUID();
  const serviceId = crypto.randomUUID();
  const stackId = crypto.randomUUID();

  cleanup(async () => {
    await db.delete(projects).where(eq(projects.id, projectId));
    await db.delete(servers).where(eq(servers.id, serverId));
    await db.delete(sshKeys).where(eq(sshKeys.id, keyId));
  });

  await db.insert(sshKeys).values({
    id: keyId,
    name: `verify-accepted-${tag}`,
    privateKeyEncrypted: "unused",
  });
  await db.insert(servers).values({
    host: `verify-accepted-${tag}.invalid`,
    id: serverId,
    name: `verify-accepted-${tag}`,
    sshKeyId: keyId,
    sshUser: "verify",
  });
  await db.insert(projects).values({
    id: projectId,
    name: `verify-accepted-${tag}`,
  });
  await db.insert(environments).values({
    id: environmentId,
    isDefault: true,
    name: "production",
    projectId,
  });
  await db.insert(services).values({
    environmentId,
    id: serviceId,
    name: "svc",
    serverId,
    sourceType: "git",
    status: "deploying",
  });
  await db.insert(stacks).values({
    environmentId,
    gitRepoUrl: "https://example.invalid/repo.git",
    id: stackId,
    name: "stk",
    serverId,
    status: "deploying",
    swarmName: `verify-accepted-${tag}`,
  });

  await suite("recordAcceptedService arms watch and clears superseded", async () => {
    const previousUntil = new Date(Date.now() + WATCH_WINDOW_MS);
    const [previous] = await db
      .insert(deployments)
      .values({
        serviceId,
        status: "succeeded",
        watchUntil: previousUntil,
      })
      .returning();
    const [current] = await db
      .insert(deployments)
      .values({ serviceId, status: "deploying" })
      .returning();
    if (!(previous && current)) {
      check("seeded service deployments", false);
      return;
    }

    const finishedAt = new Date();
    await recordAcceptedService(db, {
      deploymentId: current.id,
      finishedAt,
      nodeId: "node-abc",
      serviceId,
      swarmUpdateState: "completed",
    });

    const currentRow = await db.query.deployments.findFirst({
      where: eq(deployments.id, current.id),
    });
    const previousRow = await db.query.deployments.findFirst({
      where: eq(deployments.id, previous.id),
    });
    const serviceRow = await db.query.services.findFirst({
      where: eq(services.id, serviceId),
    });

    check("Service Deployment status succeeded", currentRow?.status === "succeeded");
    check(
      "Service Post-deploy watch armed",
      armedWithinWindow(currentRow?.watchUntil ?? null, finishedAt),
    );
    check("Service nodeId recorded", currentRow?.nodeId === "node-abc");
    check(
      "Service currentDeploymentId points at the accepted row",
      serviceRow?.currentDeploymentId === current.id,
    );
    check("Service status running", serviceRow?.status === "running");
    check("superseded Service watch cleared", previousRow?.watchUntil === null);
  });

  await suite("recordAcceptedStack arms watch and clears superseded", async () => {
    const previousUntil = new Date(Date.now() + WATCH_WINDOW_MS);
    const [previous] = await db
      .insert(stackDeployments)
      .values({
        stackId,
        status: "succeeded",
        watchUntil: previousUntil,
      })
      .returning();
    const [current] = await db
      .insert(stackDeployments)
      .values({ stackId, status: "deploying" })
      .returning();
    if (!(previous && current)) {
      check("seeded stack deployments", false);
      return;
    }

    const finishedAt = new Date();
    await recordAcceptedStack(db, {
      deploymentId: current.id,
      finishedAt,
      stackId,
      swarmUpdateStates: { web: "completed" },
    });

    const currentRow = await db.query.stackDeployments.findFirst({
      where: eq(stackDeployments.id, current.id),
    });
    const previousRow = await db.query.stackDeployments.findFirst({
      where: eq(stackDeployments.id, previous.id),
    });
    const stackRow = await db.query.stacks.findFirst({
      where: eq(stacks.id, stackId),
    });

    check("Stack Deployment status succeeded", currentRow?.status === "succeeded");
    check(
      "Stack Post-deploy watch armed",
      armedWithinWindow(currentRow?.watchUntil ?? null, finishedAt),
    );
    check(
      "Stack currentDeploymentId points at the accepted row",
      stackRow?.currentDeploymentId === current.id,
    );
    check("Stack status running", stackRow?.status === "running");
    check("superseded Stack watch cleared", previousRow?.watchUntil === null);
  });
});
