import {
  type DatabaseExtraMount,
  type DatabaseSwarmSettings,
  databases,
} from "@noddle/db/schema";
import type { DatabaseEngine } from "@noddle/shared/database-engines";
import { createServerFn } from "@tanstack/react-start";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db.server";
import { requireSession } from "@/lib/session.server";

export interface DatabaseRow {
  cpuLimitNanos: number | null;
  cpuReservationNanos: number | null;
  databaseName: string | null;
  engine: DatabaseEngine;
  environment: string;
  environmentId: string;
  externalPort: number | null;
  extraMounts: DatabaseExtraMount[];
  id: string;
  image: string | null;
  lastError: string | null;
  memoryLimitBytes: number | null;
  memoryReservationBytes: number | null;
  name: string;
  project: string;
  projectId: string;
  replicas: number;
  serverHost: string;
  serverName: string;
  status: string;
  swarmName: string;
  swarmSettings: DatabaseSwarmSettings | null;
  volumePath: string | null;
}

interface DatabaseJoined {
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
  volumePath: string | null;
}

function toDatabaseRow(d: DatabaseJoined): DatabaseRow {
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
    volumePath: d.volumePath,
  };
}

/** Impure load — no session check. Callers that are already behind a
 *  requireSession use this so overview/groups don't re-auth five times. */
export async function loadDatabaseDashboardRows(): Promise<DatabaseRow[]> {
  const rows = await db.query.databases.findMany({
    orderBy: databases.name,
    with: {
      environment: { with: { project: true } },
      server: true,
    },
  });
  return rows.map(toDatabaseRow);
}

export const getDatabaseDashboard = createServerFn({ method: "GET" }).handler(
  async (): Promise<DatabaseRow[]> => {
    await requireSession();
    return loadDatabaseDashboardRows();
  }
);

export const getDatabase = createServerFn({ method: "GET" })
  .validator((data: { databaseId: string }) => data)
  .handler(async ({ data }): Promise<DatabaseRow | null> => {
    await requireSession();
    const row = await db.query.databases.findFirst({
      where: eq(databases.id, data.databaseId),
      with: {
        environment: { with: { project: true } },
        server: true,
      },
    });
    return row ? toDatabaseRow(row) : null;
  });
