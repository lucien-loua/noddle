import { databases } from "@noddle/db/schema";
import type { DatabaseEngine } from "@noddle/shared/database-engines";
import { createServerFn } from "@tanstack/react-start";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db.server";
import { requireSession } from "@/lib/session.server";

export interface DatabaseRow {
  backupRetention: number;
  backupSchedule: "daily" | "off" | "weekly";
  cpuLimitNanos: number | null;
  cpuReservationNanos: number | null;
  engine: DatabaseEngine;
  environment: string;
  environmentId: string;
  externalPort: number | null;
  id: string;
  image: string | null;
  lastError: string | null;
  memoryLimitBytes: number | null;
  memoryReservationBytes: number | null;
  name: string;
  project: string;
  projectId: string;
  s3DestinationId: string | null;
  serverHost: string;
  serverName: string;
  status: string;
  swarmName: string;
}

interface DatabaseJoined {
  backupRetention: number;
  backupSchedule: "daily" | "off" | "weekly";
  cpuLimitNanos: number | null;
  cpuReservationNanos: number | null;
  engine: DatabaseEngine;
  environment: { name: string; project: { name: string }; projectId: string };
  environmentId: string;
  externalPort: number | null;
  id: string;
  image: string | null;
  lastError: string | null;
  memoryLimitBytes: number | null;
  memoryReservationBytes: number | null;
  name: string;
  s3DestinationId: string | null;
  server: { host: string; name: string };
  status: string;
  swarmName: string;
}

function toDatabaseRow(d: DatabaseJoined): DatabaseRow {
  return {
    backupRetention: d.backupRetention,
    backupSchedule: d.backupSchedule,
    cpuLimitNanos: d.cpuLimitNanos,
    cpuReservationNanos: d.cpuReservationNanos,
    engine: d.engine,
    environment: d.environment.name,
    environmentId: d.environmentId,
    externalPort: d.externalPort,
    id: d.id,
    image: d.image,
    lastError: d.lastError,
    memoryLimitBytes: d.memoryLimitBytes,
    memoryReservationBytes: d.memoryReservationBytes,
    name: d.name,
    project: d.environment.project.name,
    projectId: d.environment.projectId,
    s3DestinationId: d.s3DestinationId,
    serverHost: d.server.host,
    serverName: d.server.name,
    status: d.status,
    swarmName: d.swarmName,
  };
}

export const getDatabaseDashboard = createServerFn({ method: "GET" }).handler(
  async (): Promise<DatabaseRow[]> => {
    await requireSession();
    const rows = await db.query.databases.findMany({
      orderBy: databases.name,
      with: {
        environment: { with: { project: true } },
        server: true,
      },
    });
    return rows.map(toDatabaseRow);
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
