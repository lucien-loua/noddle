import type {
  DatabaseExtraMount,
  DatabaseSwarmSettings,
} from "@noddle/db/schema";
import type { DatabaseEngine } from "@noddle/shared/database-spec";
import { createServerFn } from "@tanstack/react-start";

import {
  loadDatabaseDashboardRows,
  toDatabaseRow,
} from "@/lib/database-rows.server";
import { db } from "@/lib/db.server";
import { databaseInContext } from "@/lib/team-queries.server";
import { activeTeamId } from "@/lib/team-scope.server";

export interface DatabaseRow {
  displayName: string | null;
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
  updatedAt: string;
  volumePath: string | null;
}

export const getDatabaseDashboard = createServerFn({ method: "GET" }).handler(
  async (): Promise<DatabaseRow[]> =>
    loadDatabaseDashboardRows(await activeTeamId())
);

export const getDatabase = createServerFn({ method: "GET" })
  .validator((data: { databaseId: string }) => data)
  .handler(async ({ data }): Promise<DatabaseRow | null> => {
    const row = await databaseInContext(
      db,
      await activeTeamId(),
      data.databaseId
    );
    return row ? toDatabaseRow(row) : null;
  });
