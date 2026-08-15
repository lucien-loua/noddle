import { relations } from "drizzle-orm";
import { backupConfigs, backups } from "#schema/backups";
import { databases } from "#schema/databases";
import { deploymentLogs, deployments } from "#schema/deployments";
import { envVars } from "#schema/env-vars";
import {
  githubProviders,
  gitlabProviders,
  gitProviders,
} from "#schema/git-providers";
import { environments, projects } from "#schema/projects";
import { s3Destinations } from "#schema/s3-destinations";
import { servers } from "#schema/servers";
import { serviceDomains } from "#schema/service-domains";
import { services } from "#schema/services";
import { sshKeys } from "#schema/ssh-keys";
import { stackDeploymentLogs, stackDeployments, stacks } from "#schema/stacks";
import { volumeBackupConfigs, volumeBackups } from "#schema/volume-backups";

export const projectsRelations = relations(projects, ({ many }) => ({
  environments: many(environments),
}));

export const environmentsRelations = relations(
  environments,
  ({ one, many }) => ({
    databases: many(databases),
    project: one(projects, {
      fields: [environments.projectId],
      references: [projects.id],
    }),
    services: many(services),
    stacks: many(stacks),
  })
);

export const serversRelations = relations(servers, ({ many }) => ({
  databases: many(databases),
  services: many(services),
  stacks: many(stacks),
}));

export const servicesRelations = relations(services, ({ one, many }) => ({
  deployKey: one(sshKeys, {
    fields: [services.deployKeyId],
    references: [sshKeys.id],
  }),
  deployments: many(deployments),
  domains: many(serviceDomains),
  environment: one(environments, {
    fields: [services.environmentId],
    references: [environments.id],
  }),
  envVars: many(envVars),
  gitProvider: one(gitProviders, {
    fields: [services.gitProviderId],
    references: [gitProviders.id],
  }),
  server: one(servers, {
    fields: [services.serverId],
    references: [servers.id],
  }),
  volumeBackupConfigs: many(volumeBackupConfigs),
  volumeBackups: many(volumeBackups),
}));

export const serviceDomainsRelations = relations(serviceDomains, ({ one }) => ({
  service: one(services, {
    fields: [serviceDomains.serviceId],
    references: [services.id],
  }),
}));

export const envVarsRelations = relations(envVars, ({ one }) => ({
  service: one(services, {
    fields: [envVars.serviceId],
    references: [services.id],
  }),
}));

export const deploymentsRelations = relations(deployments, ({ one, many }) => ({
  logs: many(deploymentLogs),
  service: one(services, {
    fields: [deployments.serviceId],
    references: [services.id],
  }),
}));

export const deploymentLogsRelations = relations(deploymentLogs, ({ one }) => ({
  deployment: one(deployments, {
    fields: [deploymentLogs.deploymentId],
    references: [deployments.id],
  }),
}));

export const stacksRelations = relations(stacks, ({ one, many }) => ({
  deployments: many(stackDeployments),
  environment: one(environments, {
    fields: [stacks.environmentId],
    references: [environments.id],
  }),
  server: one(servers, {
    fields: [stacks.serverId],
    references: [servers.id],
  }),
}));

export const stackDeploymentsRelations = relations(
  stackDeployments,
  ({ one, many }) => ({
    logs: many(stackDeploymentLogs),
    stack: one(stacks, {
      fields: [stackDeployments.stackId],
      references: [stacks.id],
    }),
  })
);

export const stackDeploymentLogsRelations = relations(
  stackDeploymentLogs,
  ({ one }) => ({
    deployment: one(stackDeployments, {
      fields: [stackDeploymentLogs.stackDeploymentId],
      references: [stackDeployments.id],
    }),
  })
);

export const databasesRelations = relations(databases, ({ many, one }) => ({
  backupConfigs: many(backupConfigs),
  backups: many(backups),
  environment: one(environments, {
    fields: [databases.environmentId],
    references: [environments.id],
  }),
  server: one(servers, {
    fields: [databases.serverId],
    references: [servers.id],
  }),
}));

export const backupConfigsRelations = relations(
  backupConfigs,
  ({ one, many }) => ({
    backups: many(backups),
    database: one(databases, {
      fields: [backupConfigs.databaseId],
      references: [databases.id],
    }),
    destination: one(s3Destinations, {
      fields: [backupConfigs.destinationId],
      references: [s3Destinations.id],
    }),
  })
);

// The backup job needs the server that holds the volume and the engine to
// choose its dumper: it loads the database WITH its server from this
// relation, never via a second query.
export const backupsRelations = relations(backups, ({ one }) => ({
  config: one(backupConfigs, {
    fields: [backups.configId],
    references: [backupConfigs.id],
  }),
  database: one(databases, {
    fields: [backups.databaseId],
    references: [databases.id],
  }),
  destination: one(s3Destinations, {
    fields: [backups.destinationId],
    references: [s3Destinations.id],
  }),
}));

export const volumeBackupConfigsRelations = relations(
  volumeBackupConfigs,
  ({ one, many }) => ({
    backups: many(volumeBackups),
    destination: one(s3Destinations, {
      fields: [volumeBackupConfigs.destinationId],
      references: [s3Destinations.id],
    }),
    service: one(services, {
      fields: [volumeBackupConfigs.serviceId],
      references: [services.id],
    }),
  })
);

export const volumeBackupsRelations = relations(volumeBackups, ({ one }) => ({
  config: one(volumeBackupConfigs, {
    fields: [volumeBackups.configId],
    references: [volumeBackupConfigs.id],
  }),
  destination: one(s3Destinations, {
    fields: [volumeBackups.destinationId],
    references: [s3Destinations.id],
  }),
  service: one(services, {
    fields: [volumeBackups.serviceId],
    references: [services.id],
  }),
}));

export const gitProvidersRelations = relations(
  gitProviders,
  ({ one, many }) => ({
    github: one(githubProviders, {
      fields: [gitProviders.id],
      references: [githubProviders.gitProviderId],
    }),
    gitlab: one(gitlabProviders, {
      fields: [gitProviders.id],
      references: [gitlabProviders.gitProviderId],
    }),
    services: many(services),
  })
);

export const githubProvidersRelations = relations(
  githubProviders,
  ({ one }) => ({
    gitProvider: one(gitProviders, {
      fields: [githubProviders.gitProviderId],
      references: [gitProviders.id],
    }),
  })
);

export const gitlabProvidersRelations = relations(
  gitlabProviders,
  ({ one }) => ({
    gitProvider: one(gitProviders, {
      fields: [gitlabProviders.gitProviderId],
      references: [gitProviders.id],
    }),
  })
);
