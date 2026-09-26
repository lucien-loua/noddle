import { envVars, serviceDependencies } from "@noddle/db/schema";
import { createServerFn } from "@tanstack/react-start";
import { and, eq } from "drizzle-orm";
import z from "zod";

import { db } from "@/lib/db.server";
import { guarded, identityTarget } from "@/lib/guarded.server";
import { runGuarded } from "@/lib/permission.server";
import {
  databaseDependents,
  dependenciesOfServices,
  environmentResourceIds,
  serviceInTeam,
} from "@/lib/team-queries.server";
import { activeTeamId } from "@/lib/team-scope.server";

export interface DependencyEdge {
  from: string;
  to: string;
  toKind: "database" | "service";
}

export const getEnvironmentDependencies = createServerFn({ method: "GET" })
  .validator(z.object({ environmentId: z.uuid("Choose an environment.") }))
  .handler(async ({ data }): Promise<DependencyEdge[]> => {
    const teamId = await activeTeamId();
    const inScope = await environmentResourceIds(
      db,
      teamId,
      data.environmentId
    );
    if (inScope.services.length === 0) {
      return [];
    }

    const inScopeServices = new Set(inScope.services);
    const inScopeDatabases = new Set(inScope.databases);

    const rows = await dependenciesOfServices(db, teamId, inScope.services);

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
    const rows = await databaseDependents(
      db,
      await activeTeamId(),
      data.databaseId
    );

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
        if (!(await serviceInTeam(db, await activeTeamId(), data.serviceId))) {
          throw new Error("service not found");
        }
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
