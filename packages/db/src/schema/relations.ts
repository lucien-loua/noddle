// Toutes les relations de Noddle, dans un fichier à part.
//
// Pas par goût du rangement : `services` référence `deployments` et
// `deployments` référence `services`. Déclarer les relations à côté de leur
// table créerait un cycle d'imports entre les deux fichiers. Ici, les tables
// ne dépendent que de leurs clés étrangères, et un seul fichier dépend de
// toutes les tables.
//
// Les relations de better-auth ne sont PAS ici : elles vivent dans `auth.ts`,
// qui est généré par son CLI et se réécrit d'un bloc.
import { relations } from "drizzle-orm";
import { backups } from "#schema/backups";
import { databases } from "#schema/databases";
import { deploymentLogs, deployments } from "#schema/deployments";
import { envVars } from "#schema/env-vars";
import { environments, projects } from "#schema/projects";
import { servers } from "#schema/servers";
import { services } from "#schema/services";
import { stackDeploymentLogs, stackDeployments, stacks } from "#schema/stacks";

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
  deployments: many(deployments),
  environment: one(environments, {
    fields: [services.environmentId],
    references: [environments.id],
  }),
  envVars: many(envVars),
  server: one(servers, {
    fields: [services.serverId],
    references: [servers.id],
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

// Le job de sauvegarde a besoin du serveur qui porte le volume et du moteur
// pour choisir son dumper : il charge la base AVEC son serveur depuis cette
// relation, jamais par une seconde requête.
export const backupsRelations = relations(backups, ({ one }) => ({
  database: one(databases, {
    fields: [backups.databaseId],
    references: [databases.id],
  }),
}));
