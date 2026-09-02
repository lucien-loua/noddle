import type {
  DeployJobData,
  JobKind,
  PayloadOf,
} from "@noddle/deploy-contract";

import type { WorkerDeps } from "#runtime-context";

export const handlerModules = {
  backup: () => import("#backup"),
  compose: () => import("#compose"),
  containers: () => import("#containers"),
  "dashboard-domain": () => import("#target/dashboard-domain"),
  database: () => import("#database"),
  "database-password": () => import("#database-password"),
  deploy: () => import("#deploy"),
  lifecycle: () => import("#lifecycle"),
  provision: () => import("#provision"),
  prune: () => import("#prune"),
  "registry-sweep": () => import("#registry-sweep"),
  restore: () => import("#restore"),
  teardown: () => import("#teardown"),
  "teardown-server": () => import("#teardown-server"),
  "teardown-stack": () => import("#teardown-stack"),
  "volume-backup": () => import("#volume-backup"),
  "volume-restore": () => import("#volume-restore"),
};

type Handlers = {
  [K in JobKind]: (deps: WorkerDeps, data: PayloadOf<K>) => Promise<void>;
};

export type { Handlers };

export const handlers: Handlers = {
  backup: async ({ ctx }, data) => {
    const { runBackup } = await handlerModules.backup();
    await runBackup(ctx, data.backupId);
  },
  "change-database-password": async ({ ctx }, data) => {
    const { changeDatabasePassword } =
      await handlerModules["database-password"]();
    await changeDatabasePassword(ctx, data.databaseId, data.password);
  },
  "database-lifecycle": async ({ ctx }, data) => {
    const { applyLifecycleAction } = await handlerModules.lifecycle();
    await applyLifecycleAction(
      ctx,
      { id: data.databaseId, kind: "database" },
      data.action
    );
  },
  "delete-database": async ({ ctx }, data) => {
    const { runDatabaseTeardown } = await handlerModules["teardown-stack"]();
    await runDatabaseTeardown(ctx, data.databaseId);
  },
  "delete-server": async ({ ctx }, data) => {
    const { runServerTeardown } = await handlerModules["teardown-server"]();
    await runServerTeardown(ctx, data.serverId);
  },
  "delete-service": async ({ ctx }, data) => {
    const { runServiceTeardown } = await handlerModules.teardown();
    await runServiceTeardown(ctx, data.serviceId);
  },
  "delete-stack": async ({ ctx }, data) => {
    const { runStackTeardown } = await handlerModules["teardown-stack"]();
    await runStackTeardown(ctx, data.stackId);
  },
  deploy: async ({ build, ctx, route }, data) => {
    const { runDeploy } = await handlerModules.deploy();
    await runDeploy(ctx, route, build, data);
  },
  "deploy-stack": async ({ build, ctx, route }, data) => {
    const { runStackDeploy } = await handlerModules.compose();
    await runStackDeploy(ctx, route, build, {
      stackDeploymentId: data.stackDeploymentId,
    });
  },
  lifecycle: async ({ ctx }, data) => {
    const { applyLifecycleAction } = await handlerModules.lifecycle();
    await applyLifecycleAction(
      ctx,
      { id: data.serviceId, kind: "service" },
      data.action
    );
  },
  "provision-database": async ({ build, ctx, route }, data) => {
    const { provisionDatabase } = await handlerModules.database();
    await provisionDatabase(
      ctx,
      route,
      build,
      data.databaseId,
      data.databaseDeploymentId
    );
  },
  "configure-dashboard-domain": async ({ ctx }) => {
    const { configureDashboardDomain } =
      await handlerModules["dashboard-domain"]();
    await configureDashboardDomain(ctx);
  },
  "reload-control-plane": async ({ ctx }) => {
    const { reloadControlPlane } = await handlerModules["dashboard-domain"]();
    await reloadControlPlane(ctx);
  },
  "provision-server": async ({ ctx }, data) => {
    const { provisionServer } = await handlerModules.provision();
    await provisionServer(ctx, data.serverId);
  },
  "prune-docker": async ({ ctx }) => {
    const { pruneDocker } = await handlerModules.prune();
    await pruneDocker(ctx);
  },
  "prune-registry": async ({ ctx }) => {
    const { sweepRegistry } = await handlerModules["registry-sweep"]();
    await sweepRegistry(ctx);
  },
  "rebuild-database": async ({ build, ctx, route }, data) => {
    const { rebuildDatabase } = await handlerModules.database();
    await rebuildDatabase(
      ctx,
      route,
      build,
      data.databaseId,
      data.databaseDeploymentId
    );
  },
  "restart-swarm-service": async ({ ctx }, data) => {
    const { restartSwarmServiceByName } = await handlerModules.containers();
    await restartSwarmServiceByName(ctx, data.serviceName);
  },
  restore: async ({ ctx }, data) => {
    const { runRestore } = await handlerModules.restore();
    await runRestore(ctx, {
      backupId: data.backupId,
      databaseId: data.databaseId,
      destinationId: data.destinationId,
      objectKey: data.objectKey,
    });
  },
  rollback: async ({ ctx, route }, data) => {
    const { redeployImage } = await handlerModules.deploy();
    await redeployImage(ctx, route, {
      imageTag: data.imageTag,
      serviceId: data.serviceId,
      trigger: "rollback",
    });
  },
  "rollback-stack": async ({ ctx, route }, data) => {
    const { redeployStack } = await handlerModules.compose();
    await redeployStack(ctx, route, {
      sourceDeploymentId: data.sourceDeploymentId,
      stackId: data.stackId,
      trigger: "rollback",
    });
  },
  "volume-backup": async ({ ctx }, data) => {
    const { runVolumeBackup } = await handlerModules["volume-backup"]();
    await runVolumeBackup(ctx, data.volumeBackupId);
  },
  "volume-restore": async ({ ctx }, data) => {
    const { runVolumeRestore } = await handlerModules["volume-restore"]();
    await runVolumeRestore(ctx, {
      backupId: data.volumeBackupId,
      destinationId: data.destinationId,
      objectKey: data.objectKey,
      serviceId: data.serviceId,
      volumeName: data.volumeName,
    });
  },
};

export function dispatch(
  table: Handlers,
  deps: WorkerDeps,
  data: DeployJobData
): Promise<void> {
  return (
    table[data.kind] as (d: WorkerDeps, j: DeployJobData) => Promise<void>
  )(deps, data);
}
