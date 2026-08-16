import { databases, deployments, services, stackDeployments, stacks } from '@noddle/db/schema';
import type { deploymentTrigger } from '@noddle/db/schema';
import { markDeploying } from "@noddle/shared/lifecycle";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db.server";
import { enqueueDeploy } from "@/lib/queue.server";

type DeploymentTrigger = (typeof deploymentTrigger.enumValues)[number];

export async function queueServiceDeploy(
  serviceId: string,
  opts: { commitSha?: string | null; trigger: DeploymentTrigger }
): Promise<{ deploymentId: string }> {
  const service = await db.query.services.findFirst({
    where: eq(services.id, serviceId),
  });
  if (!service) {
    throw new Error("service not found");
  }

  const [created] = await db
    .insert(deployments)
    .values({
      commitSha: opts.commitSha ?? null,
      serviceId: service.id,
      status: "queued",
      trigger: opts.trigger,
    })
    .returning();
  if (!created) {
    throw new Error("could not create deployment");
  }

  await db
    .update(services)
    .set(markDeploying(null))
    .where(eq(services.id, service.id));

  await enqueueDeploy({ deploymentId: created.id, kind: "deploy" });
  return { deploymentId: created.id };
}

export async function queueStackDeploy(
  stackId: string,
  opts: { commitSha?: string | null; trigger: DeploymentTrigger }
): Promise<{ stackDeploymentId: string }> {
  const stack = await db.query.stacks.findFirst({
    where: eq(stacks.id, stackId),
  });
  if (!stack) {
    throw new Error("stack not found");
  }

  const [created] = await db
    .insert(stackDeployments)
    .values({
      commitSha: opts.commitSha ?? null,
      stackId: stack.id,
      status: "queued",
      trigger: opts.trigger,
    })
    .returning();
  if (!created) {
    throw new Error("could not create stack deployment");
  }

  await db
    .update(stacks)
    .set(markDeploying(null))
    .where(eq(stacks.id, stack.id));

  await enqueueDeploy({ kind: "deploy-stack", stackDeploymentId: created.id });
  return { stackDeploymentId: created.id };
}

/**
 * A database has no Deploy button and no git source: creating it, or
 * changing its spec, queues provision immediately. Write `deploying` here
 * so the grid doesn't sit on "Never deployed" while the job is already
 * in flight.
 */
export async function queueDatabaseProvision(
  databaseId: string
): Promise<void> {
  await db
    .update(databases)
    .set(markDeploying(null))
    .where(eq(databases.id, databaseId));
  await enqueueDeploy({ databaseId, kind: "provision-database" });
}
