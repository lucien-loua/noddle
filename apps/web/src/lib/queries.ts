import { queryOptions } from "@tanstack/react-query";
import type { BackupSubject } from "@/lib/backup-subject";
import { getAccounts } from "@/server/accounts";
import {
  getBackups,
  getDestinations,
  getVolumeBackups,
  listBackupConfigs,
  listBackupObjects,
  listServiceVolumes,
  listVolumeBackupConfigs,
} from "@/server/backups";
import {
  getDeployments,
  getEnvironmentScope,
  getService,
} from "@/server/dashboard";
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

  backupConfigsFor: (subject: BackupSubject) => {
    if (subject.kind === "database") {
      return queryOptions({
        queryFn: () =>
          listBackupConfigs({ data: { databaseId: subject.databaseId } }),
        queryKey: ["backup-configs", subject.databaseId],
      });
    }
    return queryOptions({
      queryFn: () =>
        listVolumeBackupConfigs({ data: { serviceId: subject.serviceId } }),
      queryKey: ["volume-backup-configs", subject.serviceId],
    });
  },

  backupObjects: (destinationId: string) =>
    queryOptions({
      queryFn: () => listBackupObjects({ data: { destinationId } }),
      queryKey: ["backup-objects", destinationId],
    }),

  backupRunsFor: (subject: BackupSubject, configId: string) => {
    if (subject.kind === "database") {
      return queryOptions({
        queryFn: () =>
          getBackups({ data: { configId, databaseId: subject.databaseId } }),
        queryKey: ["backups", subject.databaseId, configId],
      });
    }
    return queryOptions({
      queryFn: () =>
        getVolumeBackups({ data: { configId, serviceId: subject.serviceId } }),
      queryKey: ["volume-backups", subject.serviceId, configId],
    });
  },

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

  service: (serviceId: string) =>
    queryOptions({
      queryFn: async () => {
        const row = await getService({ data: { serviceId } });
        if (!row) {
          throw new Error(`service not found: ${serviceId}`);
        }
        return row;
      },
      queryKey: ["service", serviceId],
    }),

  serviceMetrics: (serviceId: string) =>
    queryOptions({
      queryFn: () => getServiceMetrics({ data: { serviceId } }),
      queryKey: ["service-metrics", serviceId],
    }),

  serviceVolumes: (serviceId: string) =>
    queryOptions({
      queryFn: () => listServiceVolumes({ data: { serviceId } }),
      queryKey: ["service-volumes", serviceId],
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

  volumeBackupConfigs: (serviceId: string) =>
    queryOptions({
      queryFn: () => listVolumeBackupConfigs({ data: { serviceId } }),
      queryKey: ["volume-backup-configs", serviceId],
    }),

  volumeBackups: (serviceId: string, configId: string) =>
    queryOptions({
      queryFn: () => getVolumeBackups({ data: { configId, serviceId } }),
      queryKey: ["volume-backups", serviceId, configId],
    }),
};
