import { databases, environments, services, stacks } from "@noddle/db/schema";
import {
  createEnvironmentSchema,
  duplicateEnvironmentSchema,
  environmentIdSchema,
  renameEnvironmentSchema,
} from "@noddle/shared/validation/project";
import { createServerFn } from "@tanstack/react-start";
import { and, eq, ne } from "drizzle-orm";

import { db } from "@/lib/db.server";
import {
  copyEnvironment,
  loadEnvironmentForDuplicate,
} from "@/lib/duplicate-environment.server";
import { assertNotDefaultEnvironment } from "@/lib/environment-guard";
import { insertProjectEnvironment } from "@/lib/environment.server";
import { guarded, identityTarget } from "@/lib/guarded.server";
import { runGuarded } from "@/lib/permission.server";
import { requireSession } from "@/lib/session.server";

export interface EnvironmentView {
  description: string | null;
  id: string;
  isDefault: boolean;
  name: string;
}

export const getProjectEnvironments = createServerFn({ method: "GET" })
  .validator((data: { projectId: string }) => data)
  .handler(async ({ data }): Promise<EnvironmentView[]> => {
    await requireSession();
    const rows = await db.query.environments.findMany({
      orderBy: environments.name,
      where: eq(environments.projectId, data.projectId),
    });
    return rows.map((e) => ({
      description: e.description,
      id: e.id,
      isDefault: e.isDefault,
      name: e.name,
    }));
  });

export const createEnvironment = createServerFn({ method: "POST" })
  .validator(createEnvironmentSchema)
  .handler(async ({ data }): Promise<{ environmentId: string }> => {
    const outcome = await runGuarded({
      ...guarded.project(data.projectId),
      permission: { action: "create", resource: "service" },
      run: async () => {
        const existing = await db.query.environments.findFirst({
          where: and(
            eq(environments.projectId, data.projectId),
            eq(environments.name, data.name)
          ),
        });
        if (existing) {
          throw new Error(`"${data.name}" already exists in this project`);
        }

        const created = await insertProjectEnvironment({
          description: data.description,
          name: data.name,
          projectId: data.projectId,
        });
        return { environmentId: created.id, name: created.name };
      },
      target: ({ result }) => ({ id: result.environmentId, name: result.name }),
    });
    return { environmentId: outcome.environmentId };
  });

export const renameEnvironment = createServerFn({ method: "POST" })
  .validator(renameEnvironmentSchema)
  .handler(async ({ data }): Promise<{ ok: true }> =>
    runGuarded({
      ...guarded.environment(data.environmentId),
      permission: { action: "create", resource: "service" },
      run: async ({ row: environment }) => {
        assertNotDefaultEnvironment(environment, "rename");
        const existing = await db.query.environments.findFirst({
          where: and(
            eq(environments.projectId, environment.projectId),
            eq(environments.name, data.name),
            ne(environments.id, environment.id)
          ),
        });
        if (existing) {
          throw new Error(`"${data.name}" already exists in this project`);
        }

        await db
          .update(environments)
          .set({ description: data.description, name: data.name })
          .where(eq(environments.id, environment.id));
        return { ok: true as const };
      },
      target: identityTarget,
    })
  );

export const deleteEnvironment = createServerFn({ method: "POST" })
  .validator(environmentIdSchema)
  .handler(async ({ data }): Promise<{ ok: true }> =>
    runGuarded({
      ...guarded.environment(data.environmentId),
      permission: { action: "delete", resource: "service" },
      run: async ({ row: environment }) => {
        assertNotDefaultEnvironment(environment, "delete");
        const [service, stack, database] = await Promise.all([
          db.query.services.findFirst({
            where: eq(services.environmentId, environment.id),
          }),
          db.query.stacks.findFirst({
            where: eq(stacks.environmentId, environment.id),
          }),
          db.query.databases.findFirst({
            where: eq(databases.environmentId, environment.id),
          }),
        ]);
        if (service || stack || database) {
          throw new Error(
            "this environment still has services, stacks or databases: remove them first"
          );
        }

        await db
          .delete(environments)
          .where(eq(environments.id, environment.id));
        return { ok: true as const };
      },
      target: identityTarget,
    })
  );

export const duplicateEnvironment = createServerFn({ method: "POST" })
  .validator(duplicateEnvironmentSchema)
  .handler(
    async ({
      data,
    }): Promise<{
      databasesSkipped: number;
      environmentId: string;
      servicesCopied: number;
      stacksCopied: number;
    }> =>
      runGuarded({
        load: () => loadEnvironmentForDuplicate(data.environmentId),
        notFoundMessage: "environment not found",
        permission: { action: "create", resource: "service" },
        run: ({ row: source }) => copyEnvironment(source, data),
        target: ({ result }) => ({
          id: result.environmentId,
          name: result.environmentName,
        }),
      })
  );
