// tier: local
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
import { WATCH_WINDOW_MS } from "@noddle/deploy-engine";
import { check, cleanup, runVerify, suite } from "@noddle/testing";
import { devStack } from "@noddle/testing/dev-stack";
import { eq } from "drizzle-orm";

import {
  recordAcceptedService,
  recordAcceptedStack,
} from "#deploy/accepted-deployment";

function armedWithinWindow(watchUntil: Date | null, finishedAt: Date): boolean {
  if (!watchUntil) {
    return false;
  }
  return (
    Math.abs(watchUntil.getTime() - (finishedAt.getTime() + WATCH_WINDOW_MS)) <
    1000
  );
}

await runVerify("accepted deployment (Post-deploy watch)", async () => {
  const db = createDatabase({ url: devStack().databaseUrl });
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

  await suite(
    "recordAcceptedService arms watch and clears superseded",
    async () => {
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

      const [currentRow, previousRow, serviceRow] = await Promise.all([
        db.query.deployments.findFirst({
          where: eq(deployments.id, current.id),
        }),
        db.query.deployments.findFirst({
          where: eq(deployments.id, previous.id),
        }),
        db.query.services.findFirst({ where: eq(services.id, serviceId) }),
      ]);

      check(
        "Service Deployment status succeeded",
        currentRow?.status === "succeeded"
      );
      check(
        "Service Post-deploy watch armed",
        armedWithinWindow(currentRow?.watchUntil ?? null, finishedAt)
      );
      check("Service nodeId recorded", currentRow?.nodeId === "node-abc");
      check(
        "Service currentDeploymentId points at the accepted row",
        serviceRow?.currentDeploymentId === current.id
      );
      check("Service status running", serviceRow?.status === "running");
      check(
        "superseded Service watch cleared",
        previousRow?.watchUntil === null
      );
    }
  );

  await suite(
    "recordAcceptedStack arms watch and clears superseded",
    async () => {
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

      const [currentRow, previousRow, stackRow] = await Promise.all([
        db.query.stackDeployments.findFirst({
          where: eq(stackDeployments.id, current.id),
        }),
        db.query.stackDeployments.findFirst({
          where: eq(stackDeployments.id, previous.id),
        }),
        db.query.stacks.findFirst({ where: eq(stacks.id, stackId) }),
      ]);

      check(
        "Stack Deployment status succeeded",
        currentRow?.status === "succeeded"
      );
      check(
        "Stack Post-deploy watch armed",
        armedWithinWindow(currentRow?.watchUntil ?? null, finishedAt)
      );
      check(
        "Stack currentDeploymentId points at the accepted row",
        stackRow?.currentDeploymentId === current.id
      );
      check("Stack status running", stackRow?.status === "running");
      check("superseded Stack watch cleared", previousRow?.watchUntil === null);
    }
  );
});
