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
import { guarded, identityTarget } from "@/lib/guarded.server";
import { runGuarded } from "@/lib/permission.server";
import { requireSession } from "@/lib/session.server";

export interface DependencyEdge {
  from: string;
  to: string;
  toKind: "database" | "service";
}

export const getEnvironmentDependencies = createServerFn({ method: "GET" })
  .validator(z.object({ environmentId: z.uuid("Choose an environment.") }))
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

export interface DatabaseDependent {
  envVarKey: string | null;
  serviceId: string;
  serviceName: string;
}

export const getDatabaseDependents = createServerFn({ method: "GET" })
  .validator(z.object({ databaseId: z.uuid("Choose a database.") }))
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

export const detachDatabase = createServerFn({ method: "POST" })
  .validator(
    z.object({
      databaseId: z.uuid("Choose a database."),
      serviceId: z.uuid("Choose a service."),
    })
  )
  .handler(async ({ data }): Promise<{ removedKey: string | null }> =>
    runGuarded({
      ...guarded.database(data.databaseId),
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
      target: identityTarget,
    })
  );
