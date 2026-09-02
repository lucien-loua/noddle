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
import { eq } from "drizzle-orm";

import { db } from "@/lib/db.server";
import type { AuditTarget } from "@/lib/permission.server";

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

export const guarded = {
  account: (userId: string) => ({
    load: () => db.query.user.findFirst({ where: eq(user.id, userId) }),
    notFoundMessage: "This account no longer exists.",
  }),

  backup: (backupId: string) => ({
    load: () => db.query.backups.findFirst({ where: eq(backups.id, backupId) }),
    notFoundMessage: "backup not found",
  }),

  backupConfig: (configId: string) => ({
    load: () =>
      db.query.backupConfigs.findFirst({
        where: eq(backupConfigs.id, configId),
        with: { database: true },
      }),
    notFoundMessage: "backup config not found",
  }),

  database: (databaseId: string) => ({
    load: () =>
      db.query.databases.findFirst({ where: eq(databases.id, databaseId) }),
    notFoundMessage: "database not found",
  }),

  environment: (environmentId: string) => ({
    load: () =>
      db.query.environments.findFirst({
        where: eq(environments.id, environmentId),
      }),
    notFoundMessage: "environment not found",
  }),

  destination: (destinationId: string) => ({
    load: () =>
      db.query.s3Destinations.findFirst({
        where: eq(s3Destinations.id, destinationId),
      }),
    notFoundMessage: "destination not found",
  }),

  gitProvider: (gitProviderId: string) => ({
    load: () =>
      db.query.gitProviders.findFirst({
        where: eq(gitProviders.id, gitProviderId),
      }),
    notFoundMessage: "git provider not found",
  }),

  project: (projectId: string) => ({
    load: () =>
      db.query.projects.findFirst({
        where: eq(projects.id, projectId),
        with: { environments: true },
      }),
    notFoundMessage: "project not found",
  }),

  notificationChannel: (channelId: string) => ({
    load: () =>
      db.query.notificationChannels.findFirst({
        where: eq(notificationChannels.id, channelId),
      }),
    notFoundMessage: "channel not found",
  }),

  registry: (registryId: string) => ({
    load: () =>
      db.query.registries.findFirst({ where: eq(registries.id, registryId) }),
    notFoundMessage: "registry not found",
  }),

  server: (serverId: string) => ({
    load: () => db.query.servers.findFirst({ where: eq(servers.id, serverId) }),
    notFoundMessage: "server not found",
  }),

  service: (serviceId: string) => ({
    load: () =>
      db.query.services.findFirst({ where: eq(services.id, serviceId) }),
    notFoundMessage: "service not found",
  }),

  sshKey: (sshKeyId: string) => ({
    load: () => db.query.sshKeys.findFirst({ where: eq(sshKeys.id, sshKeyId) }),
    notFoundMessage: "ssh key not found",
  }),

  stack: (stackId: string) => ({
    load: () => db.query.stacks.findFirst({ where: eq(stacks.id, stackId) }),
    notFoundMessage: "stack not found",
  }),

  volumeBackupConfig: (configId: string) => ({
    load: () =>
      db.query.volumeBackupConfigs.findFirst({
        where: eq(volumeBackupConfigs.id, configId),
        with: { service: true },
      }),
    notFoundMessage: "volume backup config not found",
  }),

  volumeBackup: (backupId: string) => ({
    load: () =>
      db.query.volumeBackups.findFirst({
        where: eq(volumeBackups.id, backupId),
      }),
    notFoundMessage: "volume backup not found",
  }),
};
