// bun run apps/worker/src/verify-dispatch.ts
import type {
  DeployJobData,
  JobKind,
  PayloadOf,
} from "@noddle/deploy-contract";
import { check, runVerify, suite } from "@noddle/testing";
import { dispatch, type Handlers, handlerModules } from "#handlers";
import type { WorkerDeps } from "#runtime-context";

const ID = "11111111-1111-4111-8111-111111111111";

const samples: { [K in JobKind]: PayloadOf<K> } = {
  backup: { backupId: ID, kind: "backup" },
  "change-database-password": {
    databaseId: ID,
    kind: "change-database-password",
    password: "secret",
  },
  "database-lifecycle": {
    action: "restart",
    databaseId: ID,
    kind: "database-lifecycle",
  },
  "delete-database": { databaseId: ID, kind: "delete-database" },
  "delete-server": { kind: "delete-server", serverId: ID },
  "delete-service": { kind: "delete-service", serviceId: ID },
  "delete-stack": { kind: "delete-stack", stackId: ID },
  deploy: { deploymentId: ID, kind: "deploy" },
  "deploy-stack": { kind: "deploy-stack", stackDeploymentId: ID },
  lifecycle: { action: "restart", kind: "lifecycle", serviceId: ID },
  "provision-database": { databaseId: ID, kind: "provision-database" },
  "provision-server": { kind: "provision-server", serverId: ID },
  "prune-docker": { kind: "prune-docker" },
  "prune-registry": { kind: "prune-registry" },
  "rebuild-database": { databaseId: ID, kind: "rebuild-database" },
  "restart-swarm-service": {
    kind: "restart-swarm-service",
    serviceName: "svc",
  },
  restore: {
    backupId: ID,
    databaseId: ID,
    destinationId: ID,
    kind: "restore",
    objectKey: "path/to.dump",
  },
  rollback: { imageTag: "img:1", kind: "rollback", serviceId: ID },
  "rollback-stack": {
    kind: "rollback-stack",
    sourceDeploymentId: ID,
    stackId: ID,
  },
  "volume-backup": { kind: "volume-backup", volumeBackupId: ID },
  "volume-restore": {
    kind: "volume-restore",
    serviceId: ID,
    volumeBackupId: ID,
  },
};

await runVerify("worker dispatch", async () => {
  await suite("each kind fires only its spy", async () => {
    const deps = {} as WorkerDeps;
    const entries = Object.entries(samples) as [JobKind, DeployJobData][];

    await Promise.all(
      entries.map(async ([kind, sample]) => {
        const fired: JobKind[] = [];
        const spies: Handlers = Object.fromEntries(
          (Object.keys(samples) as JobKind[]).map((k) => [
            k,
            () => {
              fired.push(k);
              return Promise.resolve();
            },
          ])
        ) as never;

        await dispatch(spies, deps, sample);
        check(
          `${kind} dispatches to ${kind}`,
          fired.length === 1 && fired[0] === kind,
          `fired=[${fired.join(",")}]`
        );
      })
    );
  });

  // This suite is what pays for the handlers being lazy. Static imports made
  // a broken module fail at worker boot; they also cost +36 MB of idle RSS on
  // a 2 GB machine. Resolving every module here moves that failure to CI
  // instead of losing it — a missing export, an import cycle or a throw at
  // load time surfaces on this line, not on someone's first restore.
  await suite("every handler module resolves", async () => {
    const entries = Object.entries(handlerModules);
    check(
      "the map covers every module",
      entries.length === 16,
      `${entries.length}`
    );

    await Promise.all(
      entries.map(async ([name, load]) => {
        try {
          const mod = await load();
          check(
            `#${name} loads and exports something`,
            Object.keys(mod).length > 0
          );
        } catch (e) {
          check(
            `#${name} loads`,
            false,
            e instanceof Error ? e.message : String(e)
          );
        }
      })
    );
  });
});
