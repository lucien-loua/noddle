import type {
  DeployJobData,
  JobKind,
  PayloadOf,
} from "@noddle/deploy-contract";
import { runBackup } from "#backup";
import { redeployStack, runStackDeploy } from "#compose";
import { restartSwarmServiceByName } from "#containers";
import { provisionDatabase, rebuildDatabase } from "#database";
import { changeDatabasePassword } from "#database-password";
import { redeployImage, runDeploy } from "#deploy";
import { runDatabaseLifecycle, runLifecycle } from "#lifecycle";
import { provisionServer } from "#provision";
import { pruneDocker } from "#prune";
import { sweepRegistry } from "#registry-sweep";
import { runRestore } from "#restore";
import type { DeployContext } from "#runtime-context";
import { runServiceTeardown } from "#teardown";
import { runServerTeardown } from "#teardown-server";
import { runDatabaseTeardown, runStackTeardown } from "#teardown-stack";

type Handlers = {
  [K in JobKind]: (ctx: DeployContext, data: PayloadOf<K>) => Promise<void>;
};

export type { Handlers };

export const handlers: Handlers = {
  backup: (ctx, data) => runBackup(ctx, data.backupId),
  "change-database-password": (ctx, data) =>
    changeDatabasePassword(ctx, data.databaseId, data.password),
  "database-lifecycle": (ctx, data) =>
    runDatabaseLifecycle(ctx, data.databaseId, data.action),
  "delete-database": (ctx, data) => runDatabaseTeardown(ctx, data.databaseId),
  "delete-server": (ctx, data) => runServerTeardown(ctx, data.serverId),
  "delete-service": (ctx, data) => runServiceTeardown(ctx, data.serviceId),
  "delete-stack": (ctx, data) => runStackTeardown(ctx, data.stackId),
  deploy: (ctx, data) => runDeploy(ctx, data),
  "deploy-stack": (ctx, data) =>
    runStackDeploy(ctx, { stackDeploymentId: data.stackDeploymentId }),
  lifecycle: (ctx, data) => runLifecycle(ctx, data.serviceId, data.action),
  "provision-database": (ctx, data) => provisionDatabase(ctx, data.databaseId),
  "provision-server": (ctx, data) => provisionServer(ctx, data.serverId),
  "prune-docker": async (ctx) => {
    await pruneDocker(ctx);
  },
  "prune-registry": async (ctx) => {
    await sweepRegistry(ctx);
  },
  "rebuild-database": (ctx, data) => rebuildDatabase(ctx, data.databaseId),
  "restart-swarm-service": (ctx, data) =>
    restartSwarmServiceByName(ctx, data.serviceName),
  restore: (ctx, data) =>
    runRestore(ctx, {
      backupId: data.backupId,
      databaseId: data.databaseId,
      destinationId: data.destinationId,
      objectKey: data.objectKey,
    }),
  rollback: async (ctx, data) => {
    await redeployImage(ctx, {
      imageTag: data.imageTag,
      serviceId: data.serviceId,
      trigger: "rollback",
    });
  },
  "rollback-stack": async (ctx, data) => {
    await redeployStack(ctx, {
      sourceDeploymentId: data.sourceDeploymentId,
      stackId: data.stackId,
      trigger: "rollback",
    });
  },
};

/**
 * Narrowed lookup: TypeScript cannot correlate `data.kind` with the payload
 * across an indexed access, so the cast lives in this one line only.
 */
export function dispatch(
  table: Handlers,
  ctx: DeployContext,
  data: DeployJobData
): Promise<void> {
  return (
    table[data.kind] as (c: DeployContext, d: DeployJobData) => Promise<void>
  )(ctx, data);
}
