import type { Database } from "@noddle/db";
import { deployments, services, stackDeployments, stacks } from "@noddle/db/schema";
import { markRunning, settle } from "@noddle/shared/lifecycle";
import { watchUntilFor } from "@noddle/swarm-ops";
import { and, eq, isNotNull, ne } from "drizzle-orm";

/**
 * Records that Swarm accepted a Deployment: it is now current, and
 * Post-deploy watch is armed. Ship, Rollback, and watch recovery all
 * come through here — leaving `watchUntil` to the caller is how Rollback
 * used to slip through unwatched.
 *
 * Notify and the Swarm-refused path stay at the callers: those events
 * already diverge (deploy_succeeded vs silence on Rollback).
 */

/**
 * Any Deployment still under watch for this Service stops being watched
 * as soon as ANOTHER becomes current: its window no longer covers the
 * version actually serving. Leaving it active derails detection — a crash
 * of the NEW Deployment then reads as a loop of the OLD one, since
 * `inspectServiceHealth` checks the Swarm service's name, not which
 * Deployment produced which task. Measured: `verify-watch.ts` failed
 * through exactly this path.
 */
async function clearSupersededServiceWatch(
  db: Database,
  serviceId: string,
  currentDeploymentId: string,
): Promise<void> {
  await db
    .update(deployments)
    .set({ watchUntil: null })
    .where(
      and(
        eq(deployments.serviceId, serviceId),
        ne(deployments.id, currentDeploymentId),
        isNotNull(deployments.watchUntil),
      ),
    );
}

/** Same rule as {@link clearSupersededServiceWatch}, for a Stack. */
async function clearSupersededStackWatch(
  db: Database,
  stackId: string,
  currentDeploymentId: string,
): Promise<void> {
  await db
    .update(stackDeployments)
    .set({ watchUntil: null })
    .where(
      and(
        eq(stackDeployments.stackId, stackId),
        ne(stackDeployments.id, currentDeploymentId),
        isNotNull(stackDeployments.watchUntil),
      ),
    );
}

export async function recordAcceptedService(
  db: Database,
  opts: {
    deploymentId: string;
    finishedAt: Date;
    /**
     * Where the task ACTUALLY runs, not where we requested it. With a
     * portable image, Swarm made the choice: the dashboard must display
     * its choice, not our intent.
     */
    nodeId: string | null | undefined;
    serviceId: string;
    swarmUpdateState: string | null | undefined;
  },
): Promise<void> {
  await db
    .update(deployments)
    .set({
      finishedAt: opts.finishedAt,
      nodeId: opts.nodeId,
      status: "succeeded",
      swarmUpdateState: opts.swarmUpdateState,
      watchUntil: watchUntilFor(opts.finishedAt),
    })
    .where(eq(deployments.id, opts.deploymentId));

  await db
    .update(services)
    .set({ currentDeploymentId: opts.deploymentId, status: "running" })
    .where(eq(services.id, opts.serviceId));

  await clearSupersededServiceWatch(db, opts.serviceId, opts.deploymentId);
}

export async function recordAcceptedStack(
  db: Database,
  opts: {
    deploymentId: string;
    finishedAt: Date;
    stackId: string;
    swarmUpdateStates: Record<string, string | null>;
  },
): Promise<void> {
  await db
    .update(stackDeployments)
    .set({
      finishedAt: opts.finishedAt,
      status: settle("completed"),
      swarmUpdateStates: opts.swarmUpdateStates,
      watchUntil: watchUntilFor(opts.finishedAt),
    })
    .where(eq(stackDeployments.id, opts.deploymentId));

  await db
    .update(stacks)
    .set({ currentDeploymentId: opts.deploymentId, ...markRunning(null) })
    .where(eq(stacks.id, opts.stackId));

  await clearSupersededStackWatch(db, opts.stackId, opts.deploymentId);
}
