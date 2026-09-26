import {
  backupConfigs,
  backups,
  databases,
  serviceDomains,
  services,
  stacks,
} from "@noddle/db/schema";
import { and, eq, inArray, ne } from "drizzle-orm";

import { toSwarmNames } from "@/lib/swarm-ownership";
import type { SwarmNames } from "@/lib/swarm-ownership";
import type { Db } from "@/lib/team-queries.server";

export async function hostsInUse(
  db: Db,
  hosts: string[],
  exceptDomainId?: string
): Promise<Set<string>> {
  if (hosts.length === 0) {
    return new Set();
  }
  const rows = await db
    .select({ host: serviceDomains.host })
    .from(serviceDomains)
    .where(
      and(
        inArray(serviceDomains.host, hosts),
        exceptDomainId ? ne(serviceDomains.id, exceptDomainId) : undefined
      )
    );
  return new Set(rows.map((row) => row.host));
}

export async function destinationHolds(
  db: Db,
  destinationId: string
): Promise<{ configs: boolean; runs: boolean }> {
  const [run, config] = await Promise.all([
    db
      .select({ id: backups.id })
      .from(backups)
      .where(eq(backups.destinationId, destinationId))
      .limit(1),
    db
      .select({ id: backupConfigs.id })
      .from(backupConfigs)
      .where(eq(backupConfigs.destinationId, destinationId))
      .limit(1),
  ]);
  return { configs: config.length > 0, runs: run.length > 0 };
}

export async function swarmNamesOfInstallation(db: Db): Promise<SwarmNames> {
  const [serviceRows, databaseRows, stackRows] = await Promise.all([
    db.select({ id: services.id, name: services.name }).from(services),
    db.select({ swarmName: databases.swarmName }).from(databases),
    db.select({ swarmName: stacks.swarmName }).from(stacks),
  ]);
  return toSwarmNames({
    databases: databaseRows,
    services: serviceRows,
    stacks: stackRows,
  });
}

export async function serverHolds(
  db: Db,
  serverId: string
): Promise<{ databases: number; services: number; stacks: number }> {
  const [serviceRows, stackRows, databaseRows] = await Promise.all([
    db
      .select({ id: services.id })
      .from(services)
      .where(eq(services.serverId, serverId)),
    db
      .select({ id: stacks.id })
      .from(stacks)
      .where(eq(stacks.serverId, serverId)),
    db
      .select({ id: databases.id })
      .from(databases)
      .where(eq(databases.serverId, serverId)),
  ]);
  return {
    databases: databaseRows.length,
    services: serviceRows.length,
    stacks: stackRows.length,
  };
}

export async function gitProviderOfServices(
  db: Db
): Promise<{ gitProviderId: string | null }[]> {
  return await db
    .select({ gitProviderId: services.gitProviderId })
    .from(services);
}

export async function servicesCloningWith(
  db: Db,
  by: { deployKeyId: string } | { gitProviderId: string }
): Promise<{ name: string }[]> {
  return await db
    .select({ name: services.name })
    .from(services)
    .where(
      "gitProviderId" in by
        ? eq(services.gitProviderId, by.gitProviderId)
        : eq(services.deployKeyId, by.deployKeyId)
    );
}
