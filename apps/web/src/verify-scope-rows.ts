// tier: pure
import { check, runVerify } from "@noddle/testing";

import { scopeRows } from "@/lib/scope-rows";
import type {
  DeploymentSummary,
  Scope,
  ServiceRow,
  StackRow,
} from "@/server/dashboard";
import type { DatabaseRow } from "@/server/databases/read";

const deployment = (
  over: Partial<DeploymentSummary> = {}
): DeploymentSummary => ({
  commitSha: "abc1234",
  createdAt: "2026-01-01T00:00:00.000Z",
  finishedAt: null,
  id: "dep-1",
  imagePurged: false,
  imageTag: "app:abc1234",
  nodeName: "vps-1",
  status: "deploying",
  trigger: "manual",
  ...over,
});

const service = (over: Partial<ServiceRow> = {}): ServiceRow => ({
  autoDeploy: true,
  buildMethod: "railpack",
  buildPath: null,
  cleanCache: false,
  deployKeyId: null,
  displayName: null,
  dockerImage: null,
  domains: [],
  environment: "production",
  environmentId: "env-1",
  gitBranch: "main",
  gitProviderId: null,
  gitRepoFullName: "acme/app",
  gitRepoUrl: "https://github.com/acme/app",
  gitSubmodules: false,
  hookError: null,
  id: "svc-1",
  lastDeployment: null,
  lastError: null,
  name: "app",
  port: 3000,
  prNumber: null,
  project: "acme",
  projectId: "proj-1",
  publishDirectory: null,
  registryId: null,
  serverHost: "1.2.3.4",
  serverName: "vps-1",
  sourceType: "git",
  status: "running",
  updatedAt: "2026-01-01T00:00:00.000Z",
  watchPaths: [],
  watching: false,
  ...over,
});

const stack = (over: Partial<StackRow> = {}): StackRow => ({
  displayName: null,
  domain: null,
  environment: "production",
  environmentId: "env-1",
  gitBranch: "main",
  gitRepoUrl: "https://github.com/acme/compose",
  id: "stack-1",
  lastDeployment: null,
  lastError: null,
  name: "compose",
  port: null,
  project: "acme",
  projectId: "proj-1",
  publicService: null,
  serverName: "vps-1",
  status: "running",
  updatedAt: "2026-01-01T00:00:00.000Z",
  watching: false,
  ...over,
});

const database = (over: Partial<DatabaseRow> = {}): DatabaseRow => ({
  cpuLimitNanos: null,
  cpuReservationNanos: null,
  databaseName: "app",
  displayName: null,
  engine: "postgres",
  environment: "production",
  environmentId: "env-1",
  externalPort: null,
  extraMounts: [],
  id: "db-1",
  image: null,
  lastError: null,
  memoryLimitBytes: null,
  memoryReservationBytes: null,
  name: "postgres",
  project: "acme",
  projectId: "proj-1",
  replicas: 1,
  serverHost: "1.2.3.4",
  serverName: "vps-1",
  status: "running",
  swarmName: "postgres-db-1",
  swarmSettings: null,
  updatedAt: "2026-01-01T00:00:00.000Z",
  volumePath: null,
  ...over,
});

const scope = (over: Partial<Scope> = {}): Scope => ({
  databases: [],
  environment: "production",
  environmentId: "env-1",
  key: "proj-1:env-1",
  project: "acme",
  projectId: "proj-1",
  services: [],
  stacks: [],
  ...over,
});

await runVerify("scope-rows flattening (C6)", () => {
  const flat = scopeRows(
    scope({
      databases: [database({ id: "db-1", name: "postgres" })],
      services: [service({ id: "svc-1", name: "app" })],
      stacks: [stack({ id: "stack-1", name: "compose" })],
    })
  );
  check(
    "flattens services, stacks then databases in order",
    flat.map((r) => r.kind).join(",") === "service,stack,database"
  );
  check(
    "every row keeps its own id",
    flat.map((r) => r.id).join(",") === "svc-1,stack-1,db-1"
  );

  const named = scopeRows(
    scope({ services: [service({ displayName: null, name: "raw-name" })] })
  );
  check(
    "label falls back to name when displayName is null",
    named[0]?.label === "raw-name"
  );

  const renamed = scopeRows(
    scope({
      services: [service({ displayName: "Pretty Name", name: "raw-name" })],
    })
  );
  check(
    "label prefers displayName over name",
    renamed[0]?.label === "Pretty Name"
  );

  const buildingService = scopeRows(
    scope({
      services: [
        service({
          lastDeployment: deployment({ finishedAt: null, status: "building" }),
        }),
      ],
    })
  );
  check(
    "in-flight deployment surfaces for a service mid-build",
    buildingService[0]?.inFlightDeployment === "building"
  );

  const finishedService = scopeRows(
    scope({
      services: [
        service({
          lastDeployment: deployment({
            finishedAt: "2026-01-01T00:05:00.000Z",
            status: "building",
          }),
        }),
      ],
    })
  );
  check(
    "a finished deployment is not in flight, even mid-status",
    finishedService[0]?.inFlightDeployment === null
  );

  const idleService = scopeRows(
    scope({ services: [service({ lastDeployment: null })] })
  );
  check(
    "no deployment means no in-flight state",
    idleService[0]?.inFlightDeployment === null
  );

  const settledDeploymentService = scopeRows(
    scope({
      services: [
        service({
          lastDeployment: deployment({ finishedAt: null, status: "succeeded" }),
        }),
      ],
    })
  );
  check(
    "a settled status is not treated as in flight",
    settledDeploymentService[0]?.inFlightDeployment === null
  );

  const buildingStack = scopeRows(
    scope({
      stacks: [
        stack({
          lastDeployment: deployment({ finishedAt: null, status: "queued" }),
        }),
      ],
    })
  );
  check(
    "in-flight deployment surfaces for a stack too",
    buildingStack[0]?.inFlightDeployment === "queued"
  );

  const anyDatabase = scopeRows(scope({ databases: [database()] }));
  check(
    "a database never reports an in-flight deployment",
    anyDatabase[0]?.inFlightDeployment === null
  );
});
