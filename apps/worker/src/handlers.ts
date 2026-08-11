import type {
  DeployJobData,
  JobKind,
  PayloadOf,
} from "@noddle/deploy-contract";
import type { DeployContext } from "#runtime-context";

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
};

type Handlers = {
  [K in JobKind]: (ctx: DeployContext, data: PayloadOf<K>) => Promise<void>;
};

export type { Handlers };

export const handlers: Handlers = {
  backup: async (ctx, data) => {
    const { runBackup } = await handlerModules.backup();
    await runBackup(ctx, data.backupId);
  },
  "change-database-password": async (ctx, data) => {
    const { changeDatabasePassword } =
      await handlerModules["database-password"]();
    await changeDatabasePassword(ctx, data.databaseId, data.password);
  },
  "database-lifecycle": async (ctx, data) => {
    const { runDatabaseLifecycle } = await handlerModules.lifecycle();
    await runDatabaseLifecycle(ctx, data.databaseId, data.action);
  },
  "delete-database": async (ctx, data) => {
    const { runDatabaseTeardown } = await handlerModules["teardown-stack"]();
    await runDatabaseTeardown(ctx, data.databaseId);
  },
  "delete-server": async (ctx, data) => {
    const { runServerTeardown } = await handlerModules["teardown-server"]();
    await runServerTeardown(ctx, data.serverId);
  },
  "delete-service": async (ctx, data) => {
    const { runServiceTeardown } = await handlerModules.teardown();
    await runServiceTeardown(ctx, data.serviceId);
  },
  "delete-stack": async (ctx, data) => {
    const { runStackTeardown } = await handlerModules["teardown-stack"]();
    await runStackTeardown(ctx, data.stackId);
  },
  deploy: async (ctx, data) => {
    const { runDeploy } = await handlerModules.deploy();
    await runDeploy(ctx, data);
  },
  "deploy-stack": async (ctx, data) => {
    const { runStackDeploy } = await handlerModules.compose();
    await runStackDeploy(ctx, { stackDeploymentId: data.stackDeploymentId });
  },
  lifecycle: async (ctx, data) => {
    const { runLifecycle } = await handlerModules.lifecycle();
    await runLifecycle(ctx, data.serviceId, data.action);
  },
  "provision-database": async (ctx, data) => {
    const { provisionDatabase } = await handlerModules.database();
    await provisionDatabase(ctx, data.databaseId);
  },
  "provision-server": async (ctx, data) => {
    const { provisionServer } = await handlerModules.provision();
    await provisionServer(ctx, data.serverId);
  },
  "prune-docker": async (ctx) => {
    const { pruneDocker } = await handlerModules.prune();
    await pruneDocker(ctx);
  },
  "prune-registry": async (ctx) => {
    const { sweepRegistry } = await handlerModules["registry-sweep"]();
    await sweepRegistry(ctx);
  },
  "rebuild-database": async (ctx, data) => {
    const { rebuildDatabase } = await handlerModules.database();
    await rebuildDatabase(ctx, data.databaseId);
  },
  "restart-swarm-service": async (ctx, data) => {
    const { restartSwarmServiceByName } = await handlerModules.containers();
    await restartSwarmServiceByName(ctx, data.serviceName);
  },
  restore: async (ctx, data) => {
    const { runRestore } = await handlerModules.restore();
    await runRestore(ctx, {
      backupId: data.backupId,
      databaseId: data.databaseId,
      destinationId: data.destinationId,
      objectKey: data.objectKey,
    });
  },
  rollback: async (ctx, data) => {
    const { redeployImage } = await handlerModules.deploy();
    await redeployImage(ctx, {
      imageTag: data.imageTag,
      serviceId: data.serviceId,
      trigger: "rollback",
    });
  },
  "rollback-stack": async (ctx, data) => {
    const { redeployStack } = await handlerModules.compose();
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
