// Dépose un déploiement en file — partagé entre le déclenchement manuel
// (server function, session requise) et le webhook (signature HMAC requise à
// la place). Les deux doivent produire EXACTEMENT la même ligne et le même
// job ; dupliquer cette logique aurait fini par diverger.
import {
  deployments,
  type deploymentTrigger,
  services,
  stackDeployments,
  stacks,
} from "@noddle/db/schema";
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
    throw new Error("service introuvable");
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
    throw new Error("création du déploiement impossible");
  }

  await db
    .update(services)
    .set({ status: "deploying" })
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
    throw new Error("pile introuvable");
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
    throw new Error("création du déploiement de pile impossible");
  }

  await db
    .update(stacks)
    .set({ status: "deploying" })
    .where(eq(stacks.id, stack.id));

  await enqueueDeploy({ kind: "deploy-stack", stackDeploymentId: created.id });
  return { stackDeploymentId: created.id };
}
