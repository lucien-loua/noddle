import {
  databases,
  envVars,
  serviceDependencies,
  services,
} from "@noddle/db/schema";
import { createServerFn } from "@tanstack/react-start";
import { and, eq, inArray } from "drizzle-orm";
import z from "zod";

import { db } from "@/lib/db.server";
import { runGuarded } from "@/lib/permission.server";
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

/** One service consuming this database, and the variable that carries it. */
export interface DatabaseDependent {
  /** `null` once the variable has been deleted by hand: the edge outlives it
   *  (ADR-0021), and the screen says so rather than inventing a key. */
  envVarKey: string | null;
  serviceId: string;
  serviceName: string;
}

/** Who consumes this database — the list Attach writes into and Detach
 *  removes from. */
export const getDatabaseDependents = createServerFn({ method: "GET" })
  .validator(z.object({ databaseId: z.uuid() }))
  .handler(async ({ data }): Promise<DatabaseDependent[]> => {
    await requireSession();

    const rows = await db.query.serviceDependencies.findMany({
      where: eq(serviceDependencies.dependsOnDatabaseId, data.databaseId),
      with: { envVar: true, service: true },
    });

    return rows
      .map((row) => ({
        envVarKey: row.envVar?.key ?? null,
        serviceId: row.serviceId,
        serviceName: row.service.name,
      }))
      .toSorted((a, b) => a.serviceName.localeCompare(b.serviceName));
  });

/**
 * The counterpart to attaching: drop the edge AND the variable it wrote.
 *
 * This is the statement the ADR reserves — "this app no longer uses that
 * database" — which deleting the variable from the table is NOT. The edge is
 * read back before the variable is removed: the FK is `set null`, so
 * deleting the variable first would erase the link that says which one to
 * delete.
 */
export const detachDatabase = createServerFn({ method: "POST" })
  .validator(z.object({ databaseId: z.uuid(), serviceId: z.uuid() }))
  .handler(async ({ data }): Promise<{ removedKey: string | null }> =>
    runGuarded({
      load: () =>
        db.query.databases.findFirst({
          where: eq(databases.id, data.databaseId),
        }),
      notFoundMessage: "database not found",
      permission: { action: "attach", resource: "database" },
      run: async () => {
        const [edge] = await db
          .delete(serviceDependencies)
          .where(
            and(
              eq(serviceDependencies.serviceId, data.serviceId),
              eq(serviceDependencies.dependsOnDatabaseId, data.databaseId)
            )
          )
          .returning();

        if (!edge?.envVarId) {
          return { removedKey: null };
        }
        const [removed] = await db
          .delete(envVars)
          .where(eq(envVars.id, edge.envVarId))
          .returning();
        return { removedKey: removed?.key ?? null };
      },
      target: ({ row }) => ({ id: row.id, name: row.name }),
    })
  );
