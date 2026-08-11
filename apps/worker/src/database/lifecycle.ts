import { databases, services } from "@noddle/db/schema";
import { markRunning, markStopped } from "@noddle/shared/lifecycle";
import { swarmServiceName } from "@noddle/shared/swarm-names";
import { restartService, scaleService } from "@noddle/swarm-ops";
import { eq } from "drizzle-orm";
import { withDeployClients } from "#job-run";
import type { DeployContext } from "#runtime-context";

export type LifecycleAction = "restart" | "start" | "stop";

/**
 * Applies the action and writes the ACTUAL state, not the requested one.
 *
 * If the Swarm service doesn't exist — never deployed, or removed by hand —
 * we don't pretend to have stopped it: the row stays as it was and the
 * dashboard keeps telling the truth. The opposite would show "stopped" for
 * an application Noddle knows nothing about.
 */
export async function runLifecycle(
  ctx: DeployContext,
  serviceId: string,
  action: LifecycleAction
): Promise<void> {
  const service = await ctx.db.query.services.findFirst({
    where: eq(services.id, serviceId),
    with: { server: true },
  });
  if (!service) {
    return;
  }

  await withDeployClients(ctx, service.server, async ({ managerDocker }) => {
    // Swarm commands go through the MANAGER: only it holds the cluster's
    // replicated state, a worker node refuses them.
    const name = swarmServiceName(service);

    let applied: boolean;
    if (action === "restart") {
      applied = await restartService(managerDocker, name);
    } else {
      applied = await scaleService(
        managerDocker,
        name,
        action === "stop" ? 0 : 1
      );
    }

    if (!applied) {
      throw new Error(
        `service ${name} not found on the Swarm cluster — deploy it first`
      );
    }

    // `restart` doesn't change the state: a service that restarts stays in
    // service. Only `stop` and `start` move the row.
    if (action !== "restart") {
      await ctx.db
        .update(services)
        .set(action === "stop" ? markStopped(null) : markRunning(null))
        .where(eq(services.id, service.id));
    }
  });
}

/**
 * Same mechanism as `runLifecycle`, for a database.
 *
 * Possible WITHOUT any new infrastructure path: `provisionDatabase` already
 * sets up a real Swarm service, under `database.swarmName` — WRITTEN at
 * creation and never recomputed (see `@noddle/shared/swarm-names`), so there's
 * no need for an equivalent of `swarmServiceName()`. `scaleService` and
 * `restartService` are generic dockerode probes, not a mechanism tied to
 * application services: they only need a name.
 *
 * There is NO "deploy" equivalent here, and that's deliberate, not an
 * oversight: a database has neither a build method nor a versioned image in
 * Noddle — its image is the one chosen once at creation time. "Deploying"
 * would have nothing to rebuild.
 */
export async function runDatabaseLifecycle(
  ctx: DeployContext,
  databaseId: string,
  action: LifecycleAction
): Promise<void> {
  const database = await ctx.db.query.databases.findFirst({
    where: eq(databases.id, databaseId),
    with: { server: true },
  });
  if (!database) {
    return;
  }

  await withDeployClients(ctx, database.server, async ({ managerDocker }) => {
    const name = database.swarmName;

    let applied: boolean;
    if (action === "restart") {
      applied = await restartService(managerDocker, name);
    } else {
      applied = await scaleService(
        managerDocker,
        name,
        action === "stop" ? 0 : 1
      );
    }

    if (!applied) {
      throw new Error(
        `database service ${name} not found on the Swarm cluster — provision it first`
      );
    }

    if (action !== "restart") {
      await ctx.db
        .update(databases)
        .set(action === "stop" ? markStopped(null) : markRunning(null))
        .where(eq(databases.id, database.id));
    }
  });
}
