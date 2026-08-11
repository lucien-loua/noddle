/**
 * One factory per cache domain, so a typo can't silently invalidate the
 * wrong query — or none at all.
 *
 * `["servers"]` used to be hand-typed in three separate files
 * (servers-panel, connect-repo-dialog, connect-stack-dialog): nothing tied
 * those literals together, so a typo in one would leave the servers list
 * stale after adding a server, with no error anywhere. Same shape as the
 * silent `default:` that fell through to Redis in the engine switches —
 * a string standing in for a fact the compiler could otherwise check.
 */
export const queryKeys = {
  accounts: () => ["accounts"] as const,
  backupConfigs: (databaseId: string) =>
    ["backup-configs", databaseId] as const,
  backupObjects: (destinationId: string) =>
    ["backup-objects", destinationId] as const,
  backups: (databaseId: string, configId: string) =>
    ["backups", databaseId, configId] as const,
  channels: () => ["channels"] as const,
  databaseCredentials: (databaseId: string) =>
    ["database-credentials", databaseId] as const,
  databaseMetrics: (databaseId: string, windowHours: number) =>
    ["database-metrics", databaseId, windowHours] as const,
  deployments: (serviceId: string) => ["deployments", serviceId] as const,
  envVars: (key: string) => ["env-vars", key] as const,
  projectEnvironments: (projectId: string) =>
    ["project-environments", projectId] as const,
  registries: () => ["registries"] as const,
  registryOptions: () => ["registry-options"] as const,
  servers: () => ["servers"] as const,
  serviceMetrics: (serviceId: string) =>
    ["service-metrics", serviceId] as const,
  sshKeys: () => ["ssh-keys"] as const,
  stackDeployments: (stackId: string) =>
    ["stack-deployments", stackId] as const,
  updateStatus: () => ["update-status"] as const,
} as const;
