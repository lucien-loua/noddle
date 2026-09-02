import type { Database } from "@noddle/db";
import {
  deployments,
  services,
  stackDeployments,
  stacks,
} from "@noddle/db/schema";
import { watchUntilFor } from "@noddle/deploy-engine";
import {
  markCrashed,
  markFailed,
  markRunning,
  settle,
} from "@noddle/shared/lifecycle";
import { and, eq, isNotNull, ne } from "drizzle-orm";

async function clearSupersededServiceWatch(
  db: Database,
  serviceId: string,
  currentDeploymentId: string
): Promise<void> {
  await db
    .update(deployments)
    .set({ watchUntil: null })
    .where(
      and(
        eq(deployments.serviceId, serviceId),
        ne(deployments.id, currentDeploymentId),
        isNotNull(deployments.watchUntil)
      )
    );
}

async function clearSupersededStackWatch(
  db: Database,
  stackId: string,
  currentDeploymentId: string
): Promise<void> {
  await db
    .update(stackDeployments)
    .set({ watchUntil: null })
    .where(
      and(
        eq(stackDeployments.stackId, stackId),
        ne(stackDeployments.id, currentDeploymentId),
        isNotNull(stackDeployments.watchUntil)
      )
    );
}

export async function recordAcceptedService(
  db: Database,
  opts: {
    deploymentId: string;
    finishedAt: Date;
    nodeId: string | null | undefined;
    serviceId: string;
    swarmUpdateState: string | null | undefined;
  }
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
  }
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

export async function recordRefusedService(
  db: Database,
  opts: {
    deploymentId: string;
    finishedAt: Date;
    nodeId: string | null | undefined;
    serviceId: string;
    swarmUpdateMessage: string | null | undefined;
    swarmUpdateState: string | null | undefined;
  }
): Promise<void> {
  await db
    .update(deployments)
    .set({
      errorMessage: opts.swarmUpdateMessage,
      finishedAt: opts.finishedAt,
      nodeId: opts.nodeId,
      status: "rolled_back",
      swarmUpdateState: opts.swarmUpdateState,
    })
    .where(eq(deployments.id, opts.deploymentId));

  await db
    .update(services)
    .set({ status: "crashed" })
    .where(eq(services.id, opts.serviceId));
}

export async function recordRefusedStack(
  db: Database,
  opts: {
    deploymentId: string;
    finishedAt: Date;
    stackId: string;
    swarmUpdateStates: Record<string, string | null>;
  }
): Promise<void> {
  await db
    .update(stackDeployments)
    .set({
      finishedAt: opts.finishedAt,
      status: settle("rollback_completed"),
      swarmUpdateStates: opts.swarmUpdateStates,
    })
    .where(eq(stackDeployments.id, opts.deploymentId));

  await db
    .update(stacks)
    .set(markCrashed(null, "stack deploy rolled back"))
    .where(eq(stacks.id, opts.stackId));
}

export async function recordFailedService(
  db: Database,
  opts: { deploymentId: string; errorMessage: string; serviceId: string }
): Promise<void> {
  await db
    .update(deployments)
    .set({
      errorMessage: opts.errorMessage,
      finishedAt: new Date(),
      status: "failed",
    })
    .where(eq(deployments.id, opts.deploymentId));

  await db
    .update(services)
    .set(markFailed(null, opts.errorMessage))
    .where(eq(services.id, opts.serviceId));
}

export async function recordFailedStack(
  db: Database,
  opts: { deploymentId: string; errorMessage: string; stackId: string }
): Promise<void> {
  await db
    .update(stackDeployments)
    .set({
      errorMessage: opts.errorMessage,
      finishedAt: new Date(),
      status: "failed",
    })
    .where(eq(stackDeployments.id, opts.deploymentId));

  await db
    .update(stacks)
    .set(markCrashed(null, opts.errorMessage))
    .where(eq(stacks.id, opts.stackId));
}

export async function recordRevertedService(
  db: Database,
  opts: { deploymentId: string; errorMessage: string }
): Promise<void> {
  await db
    .update(deployments)
    .set({
      errorMessage: opts.errorMessage,
      status: "reverted_by_watch",
      watchUntil: null,
    })
    .where(eq(deployments.id, opts.deploymentId));
}

export async function recordRevertedStack(
  db: Database,
  opts: { deploymentId: string; errorMessage: string }
): Promise<void> {
  await db
    .update(stackDeployments)
    .set({
      errorMessage: opts.errorMessage,
      status: "reverted_by_watch",
      watchUntil: null,
    })
    .where(eq(stackDeployments.id, opts.deploymentId));
}

export async function recordStrandedService(
  db: Database,
  opts: { errorMessage: string; serviceId: string }
): Promise<void> {
  await db
    .update(services)
    .set(markCrashed(null, opts.errorMessage))
    .where(eq(services.id, opts.serviceId));
}

export async function recordStrandedStack(
  db: Database,
  opts: { errorMessage: string; stackId: string }
): Promise<void> {
  await db
    .update(stacks)
    .set(markCrashed(null, opts.errorMessage))
    .where(eq(stacks.id, opts.stackId));
}
