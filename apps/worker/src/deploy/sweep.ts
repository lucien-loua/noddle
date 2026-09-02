import { listComposeServiceKeys } from "@noddle/compose-engine";
import { deployments, servers, stackDeployments } from "@noddle/db/schema";
import { swarmServiceName } from "@noddle/shared/swarm-names";
import { disconnect } from "@noddle/ssh-executor";
import { inspectServiceHealth } from "@noddle/swarm-ops";
import { and, desc, eq, gt, isNotNull, lt, ne } from "drizzle-orm";

import { redeployStack } from "#compose";
import { redeployImage } from "#deploy";
import {
  recordRevertedService,
  recordRevertedStack,
  recordStrandedService,
  recordStrandedStack,
} from "#deploy/accepted-deployment";
import { notify } from "#notify";
import type { DeployContext, RouteOptions } from "#runtime-context";

export interface SweepResult {
  inspected: number;
  reverted: string[];
  strandedServices: string[];
  strandedStacks: string[];
}

export async function sweepWatch(
  ctx: DeployContext,
  route: RouteOptions
): Promise<SweepResult> {
  const now = new Date();
  const [pending, pendingStacks] = await Promise.all([
    ctx.db.query.deployments.findMany({
      where: and(
        eq(deployments.status, "succeeded"),
        isNotNull(deployments.watchUntil),
        gt(deployments.watchUntil, now)
      ),
      with: { service: { with: { server: true } } },
    }),
    ctx.db.query.stackDeployments.findMany({
      where: and(
        eq(stackDeployments.status, "succeeded"),
        isNotNull(stackDeployments.watchUntil),
        gt(stackDeployments.watchUntil, now)
      ),
      with: { stack: true },
    }),
  ]);

  const reverted: string[] = [];
  const strandedServices: string[] = [];
  const strandedStacks: string[] = [];

  if (pending.length === 0 && pendingStacks.length === 0) {
    return { inspected: 0, reverted, strandedServices, strandedStacks };
  }

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
          dep.finishedAt ?? dep.createdAt
        );
        if (!verdict.crashLooping) {
          return;
        }

        const previous = await ctx.db.query.deployments.findFirst({
          orderBy: desc(deployments.createdAt),
          where: and(
            eq(deployments.serviceId, service.id),
            eq(deployments.status, "succeeded"),
            ne(deployments.id, dep.id),
            isNotNull(deployments.imageTag),
            lt(deployments.createdAt, dep.createdAt)
          ),
        });

        const errorMessage = `crash loop after deployment (${verdict.failures} failures): ${verdict.lastError ?? "no details"}`;
        await recordRevertedService(ctx.db, {
          deploymentId: dep.id,
          errorMessage,
        });

        await notify(ctx, {
          detail: verdict.lastError ?? undefined,
          resource: service.name,
          type: "watch_reverted",
        });

        if (!previous?.imageTag) {
          await recordStrandedService(ctx.db, {
            errorMessage: "watch: crash loop",
            serviceId: service.id,
          });
          strandedServices.push(service.id);
          return;
        }

        await redeployImage(ctx, route, {
          imageTag: previous.imageTag,
          serviceId: service.id,
          trigger: "watch_revert",
        });
        reverted.push(dep.id);
      })
    );

    await Promise.all(
      pendingStacks.map(async (dep) => {
        const { stack } = dep;
        if (!dep.composeSource) {
          return;
        }

        const keys = listComposeServiceKeys(dep.composeSource);
        const verdicts = await Promise.all(
          keys.map((key) =>
            inspectServiceHealth(
              docker,
              `${stack.swarmName}_${key}`,
              dep.finishedAt ?? dep.createdAt
            )
          )
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
            lt(stackDeployments.createdAt, dep.createdAt)
          ),
        });

        await recordRevertedStack(ctx.db, {
          deploymentId: dep.id,
          errorMessage:
            "crash loop after deployment: at least one stack service is looping",
        });

        await notify(ctx, {
          detail: "at least one stack service is looping",
          resource: stack.name,
          type: "watch_reverted",
        });

        if (!previous) {
          await recordStrandedStack(ctx.db, {
            errorMessage: "watch: crash loop",
            stackId: stack.id,
          });
          strandedStacks.push(stack.id);
          return;
        }

        await redeployStack(ctx, route, {
          sourceDeploymentId: previous.id,
          stackId: stack.id,
          trigger: "watch_revert",
        });
        reverted.push(dep.id);
      })
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
