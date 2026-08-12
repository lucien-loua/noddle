/**
 * One `queryOptions()` per cache domain: the key and the fetcher that
 * fills it, co-located so they can't drift apart.
 *
 * A bare key factory (this module's previous shape) still let a caller
 * pair the right key with the wrong `queryFn`, or vice versa — nothing
 * tied the two together. `queryOptions()` returns both as one typed
 * object; spreading it into `useQuery()` also infers the data type
 * without a manual generic, and the same object works with
 * `queryClient.prefetchQuery()` / `ensureQueryData()` later if the need
 * comes up.
 *
 * Writes go through `cache` / `mutations` so call sites invalidate via
 * those adapters instead of re-typing query keys. Options that vary by
 * call site — `enabled`, `initialData`, `refetchInterval` driven by
 * local render state — are NOT here: they are call-site concerns, not
 * identity concerns, and stay spread on top at the `useQuery()` call.
 * `["servers"]` used to be hand-typed in three separate files with
 * nothing tying them together — the same shape as the silent `default:`
 * that fell through to Redis in the engine switches: a string standing
 * in for a fact the compiler could otherwise check.
 */
import { queryOptions } from "@tanstack/react-query";
import { getAccounts } from "@/server/accounts";
import {
  getBackups,
  getDestinations,
  listBackupConfigs,
  listBackupObjects,
} from "@/server/backups";
import { getDeployments, getEnvironmentScope } from "@/server/dashboard";
import { getDatabase, getDatabaseCredentials } from "@/server/databases";
import type { EnvVarTarget } from "@/server/env-vars";
import { getEnvVars } from "@/server/env-vars";
import { getProjectEnvironments } from "@/server/environments";
import { getDatabaseMetrics, getServiceMetrics } from "@/server/metrics";
import { getChannels } from "@/server/notifications";
import { getRegistries, getRegistryOptions } from "@/server/registries";
import { getServers } from "@/server/servers";
import { getSshKeys } from "@/server/ssh-keys";
import { getStackDeployments } from "@/server/stacks";
import { getUpdateStatus } from "@/server/updates";

export const queries = {
  accounts: () =>
    queryOptions({ queryFn: () => getAccounts(), queryKey: ["accounts"] }),

  backupConfigs: (databaseId: string) =>
    queryOptions({
      queryFn: () => listBackupConfigs({ data: { databaseId } }),
      queryKey: ["backup-configs", databaseId],
    }),

  backupObjects: (destinationId: string) =>
    queryOptions({
      queryFn: () => listBackupObjects({ data: { destinationId } }),
      queryKey: ["backup-objects", destinationId],
    }),

  backups: (databaseId: string, configId: string) =>
    queryOptions({
      queryFn: () => getBackups({ data: { configId, databaseId } }),
      queryKey: ["backups", databaseId, configId],
    }),

  channels: () =>
    queryOptions({ queryFn: () => getChannels(), queryKey: ["channels"] }),

  database: (databaseId: string) =>
    queryOptions({
      queryFn: async () => {
        const row = await getDatabase({ data: { databaseId } });
        if (!row) {
          throw new Error(`database not found: ${databaseId}`);
        }
        return row;
      },
      queryKey: ["database", databaseId],
    }),

  databaseCredentials: (databaseId: string) =>
    queryOptions({
      queryFn: () => getDatabaseCredentials({ data: { databaseId } }),
      queryKey: ["database-credentials", databaseId],
    }),

  databaseMetrics: (databaseId: string, windowHours: 1 | 6 | 24) =>
    queryOptions({
      queryFn: () =>
        getDatabaseMetrics({
          data: {
            databaseId,
            windowHours: ({ 1: "1", 6: "6", 24: "24" } as const)[windowHours],
          },
        }),
      queryKey: ["database-metrics", databaseId, windowHours],
    }),

  deployments: (serviceId: string) =>
    queryOptions({
      queryFn: () => getDeployments({ data: { serviceId } }),
      queryKey: ["deployments", serviceId],
    }),

  destinations: () =>
    queryOptions({
      queryFn: () => getDestinations(),
      queryKey: ["destinations"],
    }),

  environmentScope: (projectId: string, environmentId: string) =>
    queryOptions({
      queryFn: () =>
        getEnvironmentScope({ data: { environmentId, projectId } }),
      queryKey: ["environment-scope", projectId, environmentId],
    }),

  // The identifier alone is enough as a key: a Service and a Database
  // can't share theirs. `target` carries the shape `getEnvVars` needs
  // (`{ serviceId }` or `{ databaseId }`); the factory derives the cache
  // key from it rather than asking the caller to keep the two in sync.
  envVars: (target: EnvVarTarget) =>
    queryOptions({
      queryFn: () => getEnvVars({ data: target }),
      queryKey: [
        "env-vars",
        "serviceId" in target ? target.serviceId : target.databaseId,
      ],
    }),

  projectEnvironments: (projectId: string) =>
    queryOptions({
      queryFn: () => getProjectEnvironments({ data: { projectId } }),
      queryKey: ["project-environments", projectId],
    }),

  registries: () =>
    queryOptions({ queryFn: () => getRegistries(), queryKey: ["registries"] }),

  registryOptions: () =>
    queryOptions({
      queryFn: () => getRegistryOptions(),
      queryKey: ["registry-options"],
    }),

  servers: () =>
    queryOptions({ queryFn: () => getServers(), queryKey: ["servers"] }),

  serviceMetrics: (serviceId: string) =>
    queryOptions({
      queryFn: () => getServiceMetrics({ data: { serviceId } }),
      queryKey: ["service-metrics", serviceId],
    }),

  sshKeys: () =>
    queryOptions({ queryFn: () => getSshKeys(), queryKey: ["ssh-keys"] }),

  stackDeployments: (stackId: string) =>
    queryOptions({
      queryFn: () => getStackDeployments({ data: { stackId } }),
      queryKey: ["stack-deployments", stackId],
    }),

  updateStatus: () =>
    queryOptions({
      queryFn: () => getUpdateStatus(),
      queryKey: ["update-status"],
    }),
};
