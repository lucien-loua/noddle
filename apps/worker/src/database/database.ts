import { decryptSecret, secretContext } from "@noddle/crypto";
import {
  databaseDeploymentLogs,
  databaseDeployments,
  databases,
  envVars,
} from "@noddle/db/schema";
import { provisionDatabase as runProvision } from "@noddle/deploy-engine";
import type { DatabaseSwarmOverrides } from "@noddle/deploy-engine";
import { removeService } from "@noddle/deploy-engine/ops";
import { ENGINE_SPECS } from "@noddle/shared/database-spec";
import { markCrashed, markRunning } from "@noddle/shared/lifecycle";
import { eq } from "drizzle-orm";

import { withDeployClients } from "#job-run";
import { createLogSink } from "#log-sink";
import type { LogSink } from "#log-sink";
import type {
  BuildOptions,
  DeployContext,
  RouteOptions,
} from "#runtime-context";
import { databaseVolumeNames, removeVolumes } from "#volume/remove";

export async function provisionDatabase(
  ctx: DeployContext,
  route: RouteOptions,
  build: BuildOptions,
  databaseId: string,
  deploymentId?: string
): Promise<void> {
  const database = await ctx.db.query.databases.findFirst({
    where: eq(databases.id, databaseId),
    with: { server: true },
  });
  if (!database) {
    throw new Error(`database not found: ${databaseId}`);
  }

  const spec = ENGINE_SPECS[database.engine];
  const password = decryptSecret(
    database.rootPasswordEncrypted,
    ctx.appKey,
    secretContext.databasePassword(database.id)
  );

  const userEnv = (
    await ctx.db.query.envVars.findMany({
      where: eq(envVars.databaseId, database.id),
    })
  ).map(
    (row) =>
      `${row.key}=${decryptSecret(row.valueEncrypted, ctx.appKey, secretContext.envVar(row.id))}`
  );

  const image = database.image ?? spec.image;
  const deployment = deploymentId
    ? await ctx.db
        .update(databaseDeployments)
        .set({ image, startedAt: new Date(), status: "deploying" })
        .where(eq(databaseDeployments.id, deploymentId))
        .returning()
        .then((rows) => rows[0])
    : await ctx.db
        .insert(databaseDeployments)
        .values({
          databaseId: database.id,
          image,
          startedAt: new Date(),
          status: "deploying",
        })
        .returning()
        .then((rows) => rows[0]);
  if (!deployment) {
    throw new Error(`could not record a deployment for database ${databaseId}`);
  }

  let sink: LogSink | undefined;
  try {
    sink = await createLogSink({
      deploymentId: deployment.id,
      onChunk: (c) => build.onLog?.(deployment.id, c),
      root: build.logRoot,
    });
    const log = sink;

    await withDeployClients(
      ctx,
      database.server,
      async ({ buildDocker, managerDocker }) => {
        const outcome = await runProvision(
          {
            databaseName: database.databaseName,
            engine: spec,
            engineLabel: database.engine,
            env: userEnv,
            externalPort: database.externalPort,
            extraMounts: database.extraMounts,
            image,
            name: database.swarmName,
            networkName: route.networkName,
            password,
            replicas: database.replicas,
            resources: {
              cpuLimitNanos: database.cpuLimitNanos,
              cpuReservationNanos: database.cpuReservationNanos,
              memoryLimitBytes: database.memoryLimitBytes,
              memoryReservationBytes: database.memoryReservationBytes,
            },
            rootUser: database.rootUser,
            swarmNodeId: database.server.swarmNodeId,
            swarmSettings:
              database.swarmSettings as DatabaseSwarmOverrides | null,
            volumePath: database.volumePath ?? spec.volumePath,
          },
          { buildDocker, managerDocker },
          { onLog: log.write }
        );

        const message = outcome.updateMessage ?? "swarm refused";
        await ctx.db
          .update(databases)
          .set(
            outcome.accepted ? markRunning(null) : markCrashed(null, message)
          )
          .where(eq(databases.id, database.id));
        await ctx.db
          .update(databaseDeployments)
          .set({
            errorMessage: outcome.accepted ? null : message,
            finishedAt: new Date(),
            status: outcome.accepted ? "succeeded" : "failed",
            swarmUpdateState: outcome.updateState ?? null,
          })
          .where(eq(databaseDeployments.id, deployment.id));
      }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sink?.write(`✗ ${message}\n`);
    await ctx.db
      .update(databases)
      .set(markCrashed(null, message))
      .where(eq(databases.id, database.id));
    await ctx.db
      .update(databaseDeployments)
      .set({ errorMessage: message, finishedAt: new Date(), status: "failed" })
      .where(eq(databaseDeployments.id, deployment.id));
    throw error;
  } finally {
    if (sink) {
      const { byteSize, storageUrl } = await sink.close();
      await ctx.db
        .insert(databaseDeploymentLogs)
        .values({ byteSize, databaseDeploymentId: deployment.id, storageUrl });
    }
  }
}

export async function rebuildDatabase(
  ctx: DeployContext,
  route: RouteOptions,
  build: BuildOptions,
  databaseId: string,
  deploymentId?: string
): Promise<void> {
  const database = await ctx.db.query.databases.findFirst({
    where: eq(databases.id, databaseId),
    with: { server: true },
  });
  if (!database) {
    throw new Error(`database not found: ${databaseId}`);
  }

  try {
    await withDeployClients(
      ctx,
      database.server,
      async ({ buildClient, managerDocker }) => {
        await removeService(managerDocker, database.swarmName);

        await removeVolumes(
          buildClient,
          databaseVolumeNames(database),
          (volumeName) =>
            `volume ${volumeName} could not be removed, so the database was left running as it was`
        );
      }
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

  await provisionDatabase(ctx, route, build, databaseId, deploymentId);
}
