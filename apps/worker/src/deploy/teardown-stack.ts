import { setTimeout as sleep } from "node:timers/promises";

import { databases, stacks } from "@noddle/db/schema";
import { removeService } from "@noddle/deploy-engine/ops";
import type { DockerApi } from "@noddle/ssh-executor";
import { execArgv } from "@noddle/ssh-executor";
import { eq } from "drizzle-orm";

import { removeSecretIfExists } from "#database";
import { withDeployClients } from "#job-run";
import type { DeployClients } from "#job-run";
import type { DeployContext } from "#runtime-context";
import { databaseVolumeNames, removeVolumes } from "#volume/remove";

type StackRow = NonNullable<Awaited<ReturnType<typeof loadStackForTeardown>>>;
type DatabaseRow = NonNullable<
  Awaited<ReturnType<typeof loadDatabaseForTeardown>>
>;

function loadStackForTeardown(ctx: DeployContext, stackId: string) {
  return ctx.db.query.stacks.findFirst({
    where: eq(stacks.id, stackId),
    with: { server: true },
  });
}

function loadDatabaseForTeardown(ctx: DeployContext, databaseId: string) {
  return ctx.db.query.databases.findFirst({
    where: eq(databases.id, databaseId),
    with: { server: true },
  });
}

async function teardownStack(
  ctx: DeployContext,
  stack: StackRow,
  clients: DeployClients
): Promise<void> {
  const { managerClient, managerDocker } = clients;

  const removed = await execArgv(managerClient, [
    "sudo",
    "docker",
    "stack",
    "rm",
    stack.swarmName,
  ]);
  if (removed.code !== 0 && !removed.stderr.includes("Nothing found")) {
    throw new Error(
      `docker stack rm failed (${removed.code}): ${removed.stderr.slice(0, 300)}`
    );
  }

  await waitForStackGone(managerDocker, stack.swarmName);

  await ctx.db.delete(stacks).where(eq(stacks.id, stack.id));
}

export async function runStackTeardown(
  ctx: DeployContext,
  stackId: string
): Promise<void> {
  const stack = await loadStackForTeardown(ctx, stackId);
  if (!stack) {
    return;
  }

  try {
    await withDeployClients(ctx, stack.server, (clients) =>
      teardownStack(ctx, stack, clients)
    );
  } catch (error) {
    await ctx.db
      .update(stacks)
      .set({
        lastError: error instanceof Error ? error.message : String(error),
      })
      .where(eq(stacks.id, stackId));
    throw error;
  }
}

async function waitForStackGone(
  docker: DockerApi,
  swarmName: string,
  seconds = 60
): Promise<void> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const left = await docker.listServices({
      filters: JSON.stringify({ name: [`${swarmName}_`] }),
    });
    if (left.length === 0) {
      return;
    }
    await sleep(2000);
  }
}

async function teardownDatabase(
  ctx: DeployContext,
  database: DatabaseRow,
  clients: DeployClients
): Promise<void> {
  const { buildClient, managerDocker } = clients;

  await removeService(managerDocker, database.swarmName);

  await removeSecretIfExists(managerDocker, `${database.swarmName}-password`);

  await removeVolumes(
    buildClient,
    databaseVolumeNames(database),
    (volumeName) =>
      `volume ${volumeName} could not be removed, so the database row is kept and stays visible`
  );

  await ctx.db.delete(databases).where(eq(databases.id, database.id));
}

export async function runDatabaseTeardown(
  ctx: DeployContext,
  databaseId: string
): Promise<void> {
  const database = await loadDatabaseForTeardown(ctx, databaseId);
  if (!database) {
    return;
  }

  try {
    await withDeployClients(ctx, database.server, (clients) =>
      teardownDatabase(ctx, database, clients)
    );
  } catch (error) {
    await ctx.db
      .update(databases)
      .set({
        lastError: error instanceof Error ? error.message : String(error),
      })
      .where(eq(databases.id, databaseId));
    throw error;
  }
}
