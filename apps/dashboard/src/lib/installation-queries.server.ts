import { backupConfigs, backups, serviceDomains } from "@noddle/db/schema";
import { and, eq, inArray, ne } from "drizzle-orm";

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
