/**
 * Invalidate adapters for each `queries.*` domain.
 *
 * The query key lives next to `queryOptions` in `queries.ts`; this module
 * is the only place that *uses* those keys for invalidation. Panels call
 * `cache.sshKeys(qc)` instead of re-typing `["ssh-keys"]` — the seam the
 * architecture review asked for once GET already went through `queries`.
 */
import type { QueryClient } from "@tanstack/react-query";
import {
  type BackupSubject,
  databaseBackupSubject,
  volumeBackupSubject,
} from "@/lib/backup-subject";
import { queries } from "@/lib/queries";
import type { EnvVarTarget } from "@/server/env-vars";

export const cache = {
  accounts: (qc: QueryClient) =>
    qc.invalidateQueries({ queryKey: queries.accounts().queryKey }),

  /** Prefer `backupConfigsFor` — subject is the stable invalidation key. */
  backupConfigs: (qc: QueryClient, databaseId: string) =>
    cache.backupConfigsFor(qc, databaseBackupSubject(databaseId)),

  backupConfigsFor: (qc: QueryClient, subject: BackupSubject) =>
    qc.invalidateQueries({
      queryKey: queries.backupConfigsFor(subject).queryKey,
    }),

  backupRunsFor: (qc: QueryClient, subject: BackupSubject, configId: string) =>
    qc.invalidateQueries({
      queryKey: queries.backupRunsFor(subject, configId).queryKey,
    }),

  /** Prefer `backupRunsFor` with a `BackupSubject`. */
  backups: (qc: QueryClient, databaseId: string, configId: string) =>
    cache.backupRunsFor(qc, databaseBackupSubject(databaseId), configId),

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

  /** Prefer `backupConfigsFor` with a volume `BackupSubject`. */
  volumeBackupConfigs: (qc: QueryClient, serviceId: string) =>
    cache.backupConfigsFor(qc, volumeBackupSubject(serviceId)),

  /** Prefer `backupRunsFor` with a volume `BackupSubject`. */
  volumeBackups: (qc: QueryClient, serviceId: string, configId: string) =>
    cache.backupRunsFor(qc, volumeBackupSubject(serviceId), configId),
} as const;
