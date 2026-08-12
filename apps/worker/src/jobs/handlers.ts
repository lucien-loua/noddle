import type {
  DeployJobData,
  JobKind,
  PayloadOf,
} from "@noddle/deploy-contract";
import type { WorkerDeps } from "#runtime-context";

/**
 * Every worker module the table reaches, and the only place its specifier
 * appears.
 *
 * Lazy by measurement, not by taste. Static imports cost +36 MB of idle RSS
 * (62 MB → 98 MB, +58%) on a process whose machine is held at 2 GB on
 * purpose — ADR-0016 keeps it there so regressions of exactly this shape get
 * caught instead of waved through.
 *
 * Static bought one thing: a broken module failed at boot rather than at the
 * first restore in production, which on infrastructure is the better end.
 * `verify-dispatch.ts` buys it back by resolving every entry below in CI, so
 * the property survives without the memory. That verify is why this map is a
 * map and not eighteen inline `import()` calls — a specifier written inside a
 * handler body cannot be enumerated, so nothing could check it.
 */
export const handlerModules = {
  backup: () => import("#backup"),
  compose: () => import("#compose"),
  containers: () => import("#containers"),
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

/**
 * `deps.route` and `deps.build` sit next to `deps.ctx` rather than inside
 * it: only `deploy` and `compose` read them (`database` also reads `route`,
 * for the overlay network a provisioned database attaches to). Nineteen of
 * the twenty-three modules below never see either — see `RouteOptions` and
 * `BuildOptions` in `#runtime-context` for why they were pulled out of
 * `DeployContext`.
 */
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
    const { runDatabaseLifecycle } = await handlerModules.lifecycle();
    await runDatabaseLifecycle(ctx, data.databaseId, data.action);
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
    const { runLifecycle } = await handlerModules.lifecycle();
    await runLifecycle(ctx, data.serviceId, data.action);
  },
  "provision-database": async ({ ctx, route }, data) => {
    const { provisionDatabase } = await handlerModules.database();
    await provisionDatabase(ctx, route, data.databaseId);
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
  "rebuild-database": async ({ ctx, route }, data) => {
    const { rebuildDatabase } = await handlerModules.database();
    await rebuildDatabase(ctx, route, data.databaseId);
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

/**
 * Narrowed lookup: TypeScript cannot correlate `data.kind` with the payload
 * across an indexed access, so the cast lives in this one line only.
 */
export function dispatch(
  table: Handlers,
  deps: WorkerDeps,
  data: DeployJobData
): Promise<void> {
  return (
    table[data.kind] as (d: WorkerDeps, j: DeployJobData) => Promise<void>
  )(deps, data);
}
