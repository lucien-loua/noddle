import type { DatabaseEngine } from "@noddle/database-spec";
import { databases } from '@noddle/db/schema';
import type { DatabaseExtraMount, DatabaseSwarmSettings } from '@noddle/db/schema';
import { createServerFn } from "@tanstack/react-start";
import { eq } from "drizzle-orm";

import {
  loadDatabaseDashboardRows,
  toDatabaseRow,
} from "@/lib/database-rows.server";
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
  /** ISO timestamp — Restart doesn't change `status`, so the detail header
   *  settles its pending state off this bump instead. */
  updatedAt: string;
  volumePath: string | null;
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
