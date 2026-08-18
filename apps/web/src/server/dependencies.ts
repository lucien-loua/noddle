import { databases, serviceDependencies, services } from "@noddle/db/schema";
import { createServerFn } from "@tanstack/react-start";
import { eq, inArray } from "drizzle-orm";
import z from "zod";

import { db } from "@/lib/db.server";
import { requireSession } from "@/lib/session.server";

/**
 * One stored Dependency, flattened for the client: the two nullable target
 * columns become a target plus its kind (ADR-0021).
 */
export interface DependencyEdge {
  from: string;
  to: string;
  toKind: "database" | "service";
}

/**
 * The declared Dependencies inside ONE environment.
 *
 * Only the edges, never the resources: the environment Scope already ships
 * services and databases with their live status, and a second read of the
 * same rows would eventually disagree with the first — a topology showing a
 * different status from the grid beside it is worse than no topology.
 *
 * Both ends are filtered to the environment. Nothing forbids an edge across
 * two of them at the database level, and a graph that silently reached into
 * `staging` would be drawing something the screen does not scope to.
 */
export const getEnvironmentDependencies = createServerFn({ method: "GET" })
  .validator(z.object({ environmentId: z.uuid() }))
  .handler(async ({ data }): Promise<DependencyEdge[]> => {
    await requireSession();

    const [serviceRows, databaseRows] = await Promise.all([
      db
        .select({ id: services.id })
        .from(services)
        .where(eq(services.environmentId, data.environmentId)),
      db
        .select({ id: databases.id })
        .from(databases)
        .where(eq(databases.environmentId, data.environmentId)),
    ]);
    if (serviceRows.length === 0) {
      return [];
    }

    const inScopeServices = new Set(serviceRows.map((r) => r.id));
    const inScopeDatabases = new Set(databaseRows.map((r) => r.id));

    const rows = await db
      .select()
      .from(serviceDependencies)
      .where(inArray(serviceDependencies.serviceId, [...inScopeServices]));

    const edges: DependencyEdge[] = [];
    for (const row of rows) {
      if (
        row.dependsOnDatabaseId &&
        inScopeDatabases.has(row.dependsOnDatabaseId)
      ) {
        edges.push({
          from: row.serviceId,
          to: row.dependsOnDatabaseId,
          toKind: "database",
        });
      }
      if (
        row.dependsOnServiceId &&
        inScopeServices.has(row.dependsOnServiceId)
      ) {
        edges.push({
          from: row.serviceId,
          to: row.dependsOnServiceId,
          toKind: "service",
        });
      }
    }
    return edges;
  });
