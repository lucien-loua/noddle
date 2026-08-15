import type { DatabaseEngine } from "@noddle/database-spec";
import {
  type DatabaseExtraMount,
  type DatabaseSwarmSettings,
  databases,
} from "@noddle/db/schema";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db.server";
import type { DatabaseRow } from "@/server/databases/read";

export interface DatabaseJoined {
  cpuLimitNanos: number | null;
  cpuReservationNanos: number | null;
  databaseName: string | null;
  engine: DatabaseEngine;
  environment: { name: string; project: { name: string }; projectId: string };
  environmentId: string;
  externalPort: number | null;
  extraMounts: DatabaseExtraMount[];
  id: string;
  image: string | null;
  lastError: string | null;
  memoryLimitBytes: number | null;
  memoryReservationBytes: number | null;
  name: string;
  replicas: number;
  server: { host: string; name: string };
  status: string;
  swarmName: string;
  swarmSettings: DatabaseSwarmSettings | null;
  updatedAt: Date;
  volumePath: string | null;
}

export function toDatabaseRow(d: DatabaseJoined): DatabaseRow {
  return {
    cpuLimitNanos: d.cpuLimitNanos,
    cpuReservationNanos: d.cpuReservationNanos,
    databaseName: d.databaseName,
    engine: d.engine,
    environment: d.environment.name,
    environmentId: d.environmentId,
    externalPort: d.externalPort,
    extraMounts: d.extraMounts,
    id: d.id,
    image: d.image,
    lastError: d.lastError,
    memoryLimitBytes: d.memoryLimitBytes,
    memoryReservationBytes: d.memoryReservationBytes,
    name: d.name,
    project: d.environment.project.name,
    projectId: d.environment.projectId,
    replicas: d.replicas,
    serverHost: d.server.host,
    serverName: d.server.name,
    status: d.status,
    swarmName: d.swarmName,
    swarmSettings: d.swarmSettings,
    updatedAt: d.updatedAt.toISOString(),
    volumePath: d.volumePath,
  };
}

/** Impure load — no session check. Callers that are already behind a
 *  requireSession use this so overview/groups don't re-auth five times.
 *  Pass `environmentId` to scope the inventory to one environment. */
export async function loadDatabaseDashboardRows(
  environmentId?: string
): Promise<DatabaseRow[]> {
  const rows = await db.query.databases.findMany({
    orderBy: databases.name,
    where: environmentId
      ? eq(databases.environmentId, environmentId)
      : undefined,
    with: {
      environment: { with: { project: true } },
      server: true,
    },
  });
  return rows.map(toDatabaseRow);
}
