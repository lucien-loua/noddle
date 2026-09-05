import {
  databaseDeployments,
  databases,
  deployments,
  services,
  stackDeployments,
  stacks,
} from "@noddle/db/schema";
import { markFailed } from "@noddle/shared/lifecycle";
import { log } from "@noddle/shared/log";
import { eq, inArray } from "drizzle-orm";

import type { DeployContext } from "#runtime-context";

const IN_FLIGHT = ["building", "deploying"] as const;

const STALE_MESSAGE =
  "interrupted: the worker restarted while this deployment was in progress";

async function recoverServices(ctx: DeployContext): Promise<number> {
  const stale = await ctx.db.query.deployments.findMany({
    where: inArray(deployments.status, [...IN_FLIGHT]),
  });
  if (stale.length === 0) {
    return 0;
  }

  await ctx.db
    .update(deployments)
    .set({
      errorMessage: STALE_MESSAGE,
      finishedAt: new Date(),
      status: "failed",
    })
    .where(
      inArray(
        deployments.id,
        stale.map((row) => row.id)
      )
    );

  for (const serviceId of new Set(stale.map((row) => row.serviceId))) {
    const service = await ctx.db.query.services.findFirst({
      where: eq(services.id, serviceId),
    });
    if (service?.status === "deploying") {
      await ctx.db
        .update(services)
        .set(markFailed(service.status, STALE_MESSAGE))
        .where(eq(services.id, serviceId));
    }
  }

  return stale.length;
}

async function recoverStacks(ctx: DeployContext): Promise<number> {
  const stale = await ctx.db.query.stackDeployments.findMany({
    where: inArray(stackDeployments.status, [...IN_FLIGHT]),
  });
  if (stale.length === 0) {
    return 0;
  }

  await ctx.db
    .update(stackDeployments)
    .set({
      errorMessage: STALE_MESSAGE,
      finishedAt: new Date(),
      status: "failed",
    })
    .where(
      inArray(
        stackDeployments.id,
        stale.map((row) => row.id)
      )
    );

  for (const stackId of new Set(stale.map((row) => row.stackId))) {
    const stack = await ctx.db.query.stacks.findFirst({
      where: eq(stacks.id, stackId),
    });
    if (stack?.status === "deploying") {
      await ctx.db
        .update(stacks)
        .set(markFailed(stack.status, STALE_MESSAGE))
        .where(eq(stacks.id, stackId));
    }
  }

  return stale.length;
}

async function recoverDatabases(ctx: DeployContext): Promise<number> {
  const stale = await ctx.db.query.databaseDeployments.findMany({
    where: inArray(databaseDeployments.status, [...IN_FLIGHT]),
  });
  if (stale.length === 0) {
    return 0;
  }

  await ctx.db
    .update(databaseDeployments)
    .set({
      errorMessage: STALE_MESSAGE,
      finishedAt: new Date(),
      status: "failed",
    })
    .where(
      inArray(
        databaseDeployments.id,
        stale.map((row) => row.id)
      )
    );

  for (const databaseId of new Set(stale.map((row) => row.databaseId))) {
    const database = await ctx.db.query.databases.findFirst({
      where: eq(databases.id, databaseId),
    });
    if (database?.status === "deploying") {
      await ctx.db
        .update(databases)
        .set(markFailed(database.status, STALE_MESSAGE))
        .where(eq(databases.id, databaseId));
    }
  }

  return stale.length;
}

export async function recoverStaleDeployments(
  ctx: DeployContext
): Promise<number> {
  const service = await recoverServices(ctx);
  const stack = await recoverStacks(ctx);
  const database = await recoverDatabases(ctx);
  const total = service + stack + database;

  if (total > 0) {
    log.write("deployments.recovered", { database, service, stack });
  }
  return total;
}
