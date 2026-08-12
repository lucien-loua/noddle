/**
 * Invalidate adapters for each `queries.*` domain.
 *
 * The query key lives next to `queryOptions` in `queries.ts`; this module
 * is the only place that *uses* those keys for invalidation. Panels call
 * `cache.sshKeys(qc)` instead of re-typing `["ssh-keys"]` — the seam the
 * architecture review asked for once GET already went through `queries`.
 */
import type { QueryClient } from "@tanstack/react-query";
import { queries } from "@/lib/queries";
import type { EnvVarTarget } from "@/server/env-vars";

export const cache = {
  accounts: (qc: QueryClient) =>
    qc.invalidateQueries({ queryKey: queries.accounts().queryKey }),

  backupConfigs: (qc: QueryClient, databaseId: string) =>
    qc.invalidateQueries({
      queryKey: queries.backupConfigs(databaseId).queryKey,
    }),

  backups: (qc: QueryClient, databaseId: string, configId: string) =>
    qc.invalidateQueries({
      queryKey: queries.backups(databaseId, configId).queryKey,
    }),

  channels: (qc: QueryClient) =>
    qc.invalidateQueries({ queryKey: queries.channels().queryKey }),

  database: (qc: QueryClient, databaseId: string) =>
    qc.invalidateQueries({
      queryKey: queries.database(databaseId).queryKey,
    }),

  destinations: (qc: QueryClient) =>
    qc.invalidateQueries({ queryKey: queries.destinations().queryKey }),

  environmentScope: (
    qc: QueryClient,
    projectId: string,
    environmentId: string
  ) =>
    qc.invalidateQueries({
      queryKey: queries.environmentScope(projectId, environmentId).queryKey,
    }),

  envVars: (qc: QueryClient, target: EnvVarTarget) =>
    qc.invalidateQueries({ queryKey: queries.envVars(target).queryKey }),

  registries: (qc: QueryClient) =>
    qc.invalidateQueries({ queryKey: queries.registries().queryKey }),

  registryOptions: (qc: QueryClient) =>
    qc.invalidateQueries({ queryKey: queries.registryOptions().queryKey }),

  servers: (qc: QueryClient) =>
    qc.invalidateQueries({ queryKey: queries.servers().queryKey }),

  service: (qc: QueryClient, serviceId: string) =>
    qc.invalidateQueries({
      queryKey: queries.service(serviceId).queryKey,
    }),

  sshKeys: (qc: QueryClient) =>
    qc.invalidateQueries({ queryKey: queries.sshKeys().queryKey }),

  volumeBackupConfigs: (qc: QueryClient, serviceId: string) =>
    qc.invalidateQueries({
      queryKey: queries.volumeBackupConfigs(serviceId).queryKey,
    }),

  volumeBackups: (qc: QueryClient, serviceId: string, configId: string) =>
    qc.invalidateQueries({
      queryKey: queries.volumeBackups(serviceId, configId).queryKey,
    }),
} as const;
