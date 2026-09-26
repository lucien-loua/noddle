import {
  backupConfigs,
  backups,
  databases,
  environments,
  gitProviders,
  notificationChannels,
  projects,
  registries,
  s3Destinations,
  servers,
  services,
  sshKeys,
  stacks,
  user,
  volumeBackupConfigs,
  volumeBackups,
} from "@noddle/db/schema";
import { and, eq, inArray } from "drizzle-orm";

import { db } from "@/lib/db.server";
import type { AuditTarget } from "@/lib/permission.server";
import {
  activeTeamId,
  databasesOfTeam,
  environmentsOfTeam,
  projectsOfTeam,
  servicesOfTeam,
} from "@/lib/team-scope.server";

export function identityTarget(ctx: {
  row: { id: string; name: string };
}): AuditTarget {
  return { id: ctx.row.id, name: ctx.row.name };
}

export function emailTarget(ctx: {
  row: { id: string; email: string };
}): AuditTarget {
  return { id: ctx.row.id, name: ctx.row.email };
}

export const TEAM_SCOPED_LOADERS = [
  "backup",
  "backupConfig",
  "database",
  "environment",
  "project",
  "service",
  "stack",
  "volumeBackup",
  "volumeBackupConfig",
] as const;

export const INSTALLATION_LOADERS = [
  "account",
  "destination",
  "gitProvider",
  "notificationChannel",
  "registry",
  "server",
  "sshKey",
] as const;

export const guarded = {
  account: (userId: string) => ({
    load: async () => db.query.user.findFirst({ where: eq(user.id, userId) }),
    notFoundMessage: "This account no longer exists.",
  }),

  backup: (backupId: string) => ({
    load: async () =>
      db.query.backups.findFirst({
        where: and(
          eq(backups.id, backupId),
          inArray(backups.databaseId, databasesOfTeam(await activeTeamId()))
        ),
      }),
    notFoundMessage: "backup not found",
  }),

  backupConfig: (configId: string) => ({
    load: async () =>
      db.query.backupConfigs.findFirst({
        where: and(
          eq(backupConfigs.id, configId),
          inArray(
            backupConfigs.databaseId,
            databasesOfTeam(await activeTeamId())
          )
        ),
        with: { database: true },
      }),
    notFoundMessage: "backup config not found",
  }),

  database: (databaseId: string) => ({
    load: async () =>
      db.query.databases.findFirst({
        where: and(
          eq(databases.id, databaseId),
          inArray(
            databases.environmentId,
            environmentsOfTeam(await activeTeamId())
          )
        ),
      }),
    notFoundMessage: "database not found",
  }),

  environment: (environmentId: string) => ({
    load: async () =>
      db.query.environments.findFirst({
        where: and(
          eq(environments.id, environmentId),
          inArray(environments.projectId, projectsOfTeam(await activeTeamId()))
        ),
      }),
    notFoundMessage: "environment not found",
  }),

  destination: (destinationId: string) => ({
    load: async () =>
      db.query.s3Destinations.findFirst({
        where: eq(s3Destinations.id, destinationId),
      }),
    notFoundMessage: "destination not found",
  }),

  gitProvider: (gitProviderId: string) => ({
    load: async () =>
      db.query.gitProviders.findFirst({
        where: eq(gitProviders.id, gitProviderId),
      }),
    notFoundMessage: "git provider not found",
  }),

  project: (projectId: string) => ({
    load: async () =>
      db.query.projects.findFirst({
        where: and(
          eq(projects.id, projectId),
          eq(projects.teamId, await activeTeamId())
        ),
        with: { environments: true },
      }),
    notFoundMessage: "project not found",
  }),

  notificationChannel: (channelId: string) => ({
    load: async () =>
      db.query.notificationChannels.findFirst({
        where: eq(notificationChannels.id, channelId),
      }),
    notFoundMessage: "channel not found",
  }),

  registry: (registryId: string) => ({
    load: async () =>
      db.query.registries.findFirst({ where: eq(registries.id, registryId) }),
    notFoundMessage: "registry not found",
  }),

  server: (serverId: string) => ({
    load: async () =>
      db.query.servers.findFirst({ where: eq(servers.id, serverId) }),
    notFoundMessage: "server not found",
  }),

  service: (serviceId: string) => ({
    load: async () =>
      db.query.services.findFirst({
        where: and(
          eq(services.id, serviceId),
          inArray(
            services.environmentId,
            environmentsOfTeam(await activeTeamId())
          )
        ),
      }),
    notFoundMessage: "service not found",
  }),

  sshKey: (sshKeyId: string) => ({
    load: async () =>
      db.query.sshKeys.findFirst({ where: eq(sshKeys.id, sshKeyId) }),
    notFoundMessage: "ssh key not found",
  }),

  stack: (stackId: string) => ({
    load: async () =>
      db.query.stacks.findFirst({
        where: and(
          eq(stacks.id, stackId),
          inArray(
            stacks.environmentId,
            environmentsOfTeam(await activeTeamId())
          )
        ),
      }),
    notFoundMessage: "stack not found",
  }),

  volumeBackupConfig: (configId: string) => ({
    load: async () =>
      db.query.volumeBackupConfigs.findFirst({
        where: and(
          eq(volumeBackupConfigs.id, configId),
          inArray(
            volumeBackupConfigs.serviceId,
            servicesOfTeam(await activeTeamId())
          )
        ),
        with: { service: true },
      }),
    notFoundMessage: "volume backup config not found",
  }),

  volumeBackup: (backupId: string) => ({
    load: async () =>
      db.query.volumeBackups.findFirst({
        where: and(
          eq(volumeBackups.id, backupId),
          inArray(volumeBackups.serviceId, servicesOfTeam(await activeTeamId()))
        ),
      }),
    notFoundMessage: "volume backup not found",
  }),
};
