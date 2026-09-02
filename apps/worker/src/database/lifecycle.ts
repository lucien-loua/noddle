import { databases, services } from "@noddle/db/schema";
import { markRunning, markStopped } from "@noddle/shared/lifecycle";
import type { StatusPatch } from "@noddle/shared/lifecycle";
import { swarmServiceName } from "@noddle/shared/swarm-names";
import {
  restartService,
  scaleService,
  waitForRunningTask,
} from "@noddle/swarm-ops";
import { eq } from "drizzle-orm";

import { withDeployClients } from "#job-run";
import type { DeployContext } from "#runtime-context";

export type LifecycleAction = "restart" | "start" | "stop";

export interface LifecycleTarget {
  id: string;
  kind: "database" | "service";
}

interface ResolvedTarget {
  applyStatus: (
    ctx: DeployContext,
    values: StatusPatch | { updatedAt: Date }
  ) => Promise<unknown>;
  missingMessage: string;
  swarmName: string;
}

function statusPatchFor(
  action: LifecycleAction
): StatusPatch | { updatedAt: Date } {
  if (action === "restart") {
    return { updatedAt: new Date() };
  }
  return action === "stop" ? markStopped(null) : markRunning(null);
}

async function resolveTarget(
  ctx: DeployContext,
  target: LifecycleTarget
): Promise<{
  resolved: ResolvedTarget;
  server: Parameters<typeof withDeployClients>[1];
} | null> {
  if (target.kind === "database") {
    const database = await ctx.db.query.databases.findFirst({
      where: eq(databases.id, target.id),
      with: { server: true },
    });
    if (!database) {
      return null;
    }
    return {
      resolved: {
        applyStatus: (c, values) =>
          c.db
            .update(databases)
            .set(values)
            .where(eq(databases.id, database.id)),
        missingMessage: `database service ${database.swarmName} not found on the Swarm cluster: provision it first`,
        swarmName: database.swarmName,
      },
      server: database.server,
    };
  }

  const service = await ctx.db.query.services.findFirst({
    where: eq(services.id, target.id),
    with: { server: true },
  });
  if (!service) {
    return null;
  }
  const swarmName = swarmServiceName(service);
  return {
    resolved: {
      applyStatus: (c, values) =>
        c.db.update(services).set(values).where(eq(services.id, service.id)),
      missingMessage: `service ${swarmName} not found on the Swarm cluster: deploy it first`,
      swarmName,
    },
    server: service.server,
  };
}

export async function applyLifecycleAction(
  ctx: DeployContext,
  target: LifecycleTarget,
  action: LifecycleAction
): Promise<void> {
  const found = await resolveTarget(ctx, target);
  if (!found) {
    return;
  }
  const { resolved, server } = found;

  await withDeployClients(ctx, server, async ({ managerDocker }) => {
    const applied =
      action === "restart"
        ? await restartService(managerDocker, resolved.swarmName)
        : await scaleService(
            managerDocker,
            resolved.swarmName,
            action === "stop" ? 0 : 1
          );

    if (!applied) {
      throw new Error(resolved.missingMessage);
    }

    if (action !== "stop") {
      await waitForRunningTask(managerDocker, resolved.swarmName);
    }

    await resolved.applyStatus(ctx, statusPatchFor(action));
  });
}
