import { listComposeServiceKeys } from "@noddle/compose-engine";
import { deployments, servers, services, stackDeployments, stacks } from "@noddle/db/schema";
import { markCrashed } from "@noddle/shared/lifecycle";
import { swarmServiceName } from "@noddle/shared/swarm-names";
import { disconnect } from "@noddle/ssh-executor";
import { inspectServiceHealth } from "@noddle/swarm-ops";
import { and, desc, eq, gt, isNotNull, lt, ne } from "drizzle-orm";

import { redeployStack } from "#compose";
import { redeployImage } from "#deploy";
import { notify } from "#notify";
import type { DeployContext, RouteOptions } from "#runtime-context";

export interface SweepResult {
  /** Deployments still under watch on this pass. */
  inspected: number;
  /** Deployments whose crash loop was detected. */
  reverted: string[];
  /** Detected but with no earlier version to roll back to. */
  strandedServices: string[];
  /** Same thing, for a compose stack. */
  strandedStacks: string[];
}

export async function sweepWatch(ctx: DeployContext, route: RouteOptions): Promise<SweepResult> {
  const now = new Date();
  const pending = await ctx.db.query.deployments.findMany({
    where: and(
      eq(deployments.status, "succeeded"),
      isNotNull(deployments.watchUntil),
      gt(deployments.watchUntil, now),
    ),
    with: { service: { with: { server: true } } },
  });
  const pendingStacks = await ctx.db.query.stackDeployments.findMany({
    where: and(
      eq(stackDeployments.status, "succeeded"),
      isNotNull(stackDeployments.watchUntil),
      gt(stackDeployments.watchUntil, now),
    ),
    with: { stack: true },
  });

  const reverted: string[] = [];
  const strandedServices: string[] = [];
  const strandedStacks: string[] = [];

  if (pending.length === 0 && pendingStacks.length === 0) {
    return { inspected: 0, reverted, strandedServices, strandedStacks };
  }

  // One manager: one connection for the whole pass, not one per inspected
  // deployment — nor per inspected stack service.
  const manager = await ctx.db.query.servers.findFirst({
    where: eq(servers.role, "manager"),
  });
  if (!manager) {
    throw new Error("no Swarm manager registered");
  }
  const managerClient = await ctx.connectTo(manager);
  const docker = ctx.createDockerApi(managerClient);

  try {
    await Promise.all(
      pending.map(async (dep) => {
        const { service } = dep;

        const verdict = await inspectServiceHealth(
          docker,
          swarmServiceName(service),
          dep.finishedAt ?? dep.createdAt,
        );
        if (!verdict.crashLooping) {
          return;
        }

        // The earlier version that actually served. Noddle aims at any entry
        // in its history — Swarm keeps only one.
        const previous = await ctx.db.query.deployments.findFirst({
          orderBy: desc(deployments.createdAt),
          where: and(
            eq(deployments.serviceId, service.id),
            eq(deployments.status, "succeeded"),
            ne(deployments.id, dep.id),
            isNotNull(deployments.imageTag),
            lt(deployments.createdAt, dep.createdAt),
          ),
        });

        await ctx.db
          .update(deployments)
          .set({
            errorMessage: `crash loop after deployment (${verdict.failures} failures): ${verdict.lastError ?? "no details"}`,
            status: "reverted_by_watch",
            watchUntil: null,
          })
          .where(eq(deployments.id, dep.id));

        // The most important event in the product: Noddle took back control
        // on its own, on a deployment Swarm had declared successful. If a
        // single notification had to exist, it would be this one.
        await notify(ctx, {
          detail: verdict.lastError ?? undefined,
          resource: service.name,
          type: "watch_reverted",
        });

        if (!previous?.imageTag) {
          // First version of the service: nothing to roll back to. Signal
          // it rather than hide the state.
          await ctx.db
            .update(services)
            .set(markCrashed(null, "watch: crash loop"))
            .where(eq(services.id, service.id));
          strandedServices.push(service.id);
          return;
        }

        await redeployImage(ctx, route, {
          imageTag: previous.imageTag,
          serviceId: service.id,
          trigger: "watch_revert",
        });
        reverted.push(dep.id);
      }),
    );

    await Promise.all(
      pendingStacks.map(async (dep) => {
        const { stack } = dep;
        if (!dep.composeSource) {
          return;
        }

        // A stack is looping if ANY of its containers is looping — a
        // private Redis restarting in a loop is just as broken as a public
        // service doing it, even if Traefik never sees it.
        const keys = listComposeServiceKeys(dep.composeSource);
        const verdicts = await Promise.all(
          keys.map((key) =>
            inspectServiceHealth(
              docker,
              `${stack.swarmName}_${key}`,
              dep.finishedAt ?? dep.createdAt,
            ),
          ),
        );
        if (!verdicts.some((v) => v.crashLooping)) {
          return;
        }

        const previous = await ctx.db.query.stackDeployments.findFirst({
          orderBy: desc(stackDeployments.createdAt),
          where: and(
            eq(stackDeployments.stackId, stack.id),
            eq(stackDeployments.status, "succeeded"),
            ne(stackDeployments.id, dep.id),
            isNotNull(stackDeployments.composeSource),
            lt(stackDeployments.createdAt, dep.createdAt),
          ),
        });

        await ctx.db
          .update(stackDeployments)
          .set({
            errorMessage: "crash loop after deployment: at least one stack service is looping",
            status: "reverted_by_watch",
            watchUntil: null,
          })
          .where(eq(stackDeployments.id, dep.id));

        await notify(ctx, {
          detail: "at least one stack service is looping",
          resource: stack.name,
          type: "watch_reverted",
        });

        if (!previous) {
          await ctx.db
            .update(stacks)
            .set(markCrashed(null, "watch: crash loop"))
            .where(eq(stacks.id, stack.id));
          strandedStacks.push(stack.id);
          return;
        }

        await redeployStack(ctx, route, {
          sourceDeploymentId: previous.id,
          stackId: stack.id,
          trigger: "watch_revert",
        });
        reverted.push(dep.id);
      }),
    );
  } finally {
    disconnect(managerClient);
  }

  return {
    inspected: pending.length + pendingStacks.length,
    reverted,
    strandedServices,
    strandedStacks,
  };
}
