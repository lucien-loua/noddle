// tier: pure
import { check, expectThrows, runVerify, suite } from "@noddle/testing";

import { deployJobSchema } from "./index.ts";
import type { JobKind, PayloadOf } from "./index.ts";

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
  "configure-dashboard-domain": { kind: "configure-dashboard-domain" },
  "reload-control-plane": { kind: "reload-control-plane" },
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

await runVerify("deploy-contract job schema", async () => {
  await suite("every JobKind parses", () => {
    for (const [kind, sample] of Object.entries(samples)) {
      const parsed = deployJobSchema.safeParse(sample);
      check(`${kind} parses`, parsed.success);
    }
  });

  expectThrows("unknown kind is refused", () =>
    deployJobSchema.parse({ kind: "not-a-real-kind" })
  );

  expectThrows("extra key is refused (strictObject)", () =>
    deployJobSchema.parse({ kind: "prune-docker", surplus: true })
  );
});
