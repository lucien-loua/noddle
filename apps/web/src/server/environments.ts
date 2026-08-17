import { databases, environments, projects, services, stacks } from "@noddle/db/schema";
import {
  createEnvironmentSchema,
  duplicateEnvironmentSchema,
  environmentIdSchema,
  renameEnvironmentSchema,
} from "@noddle/shared/validation/project";
import { createServerFn } from "@tanstack/react-start";
import { and, eq, ne } from "drizzle-orm";

import { db } from "@/lib/db.server";
import { copyEnvironment, loadEnvironmentForDuplicate } from "@/lib/duplicate-environment.server";
import { assertNotDefaultEnvironment } from "@/lib/environment-guard";
import { insertProjectEnvironment } from "@/lib/environment.server";
import { runGuarded } from "@/lib/permission.server";
import { requireSession } from "@/lib/session.server";

export interface EnvironmentView {
  description: string | null;
  id: string;
  isDefault: boolean;
  name: string;
}

/**
 * ALL of a project's environments, even those without a single resource.
 *
 * Distinct from `getDashboardGroups`: there, a `Scope` only exists as a side
 * effect of connecting a resource — true since Phase 1, and it stays that
 * way for `/`, `/deployments` and the sidebar, which have no reason to
 * change. But `createEnvironment` is the FIRST way to make an environment
 * exist without connecting anything to it at the same time: without this
 * separate read, a freshly created and still-empty environment would show
 * up nowhere, including in the selector whose whole purpose is to deploy
 * its first resource there.
 */
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
    const guarded = await runGuarded({
      // Loads the parent Project — it must exist — but the object recorded
      // is the Environment that comes out of `run`.
      load: () => db.query.projects.findFirst({ where: eq(projects.id, data.projectId) }),
      notFoundMessage: "project not found",
      permission: { action: "create", resource: "service" },
      run: async () => {
        const existing = await db.query.environments.findFirst({
          where: and(eq(environments.projectId, data.projectId), eq(environments.name, data.name)),
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
    return { environmentId: guarded.environmentId };
  });

export const renameEnvironment = createServerFn({ method: "POST" })
  .validator(renameEnvironmentSchema)
  .handler(async ({ data }): Promise<{ ok: true }> =>
    runGuarded({
      load: () =>
        db.query.environments.findFirst({
          where: eq(environments.id, data.environmentId),
        }),
      notFoundMessage: "environment not found",
      permission: { action: "create", resource: "service" },
      run: async ({ row: environment }) => {
        assertNotDefaultEnvironment(environment, "rename");
        const existing = await db.query.environments.findFirst({
          where: and(
            eq(environments.projectId, environment.projectId),
            eq(environments.name, data.name),
            ne(environments.id, environment.id),
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
      target: ({ row }) => ({ id: row.id, name: row.name }),
    }),
  );

/**
 * Delete an environment — refused if it is the default, or if it carries
 * the slightest resource.
 *
 * The default is the environment a project is born with: deleting it would
 * leave `/projects/<id>` with nothing to redirect to. Extra environments
 * that still contain a service, a stack or a database have real
 * infrastructure behind them — that path goes through the dedicated delete
 * buttons, with THEIR own confirmation. An empty non-default environment,
 * on the other hand, is just a row: no job, no name confirmation.
 */
export const deleteEnvironment = createServerFn({ method: "POST" })
  .validator(environmentIdSchema)
  .handler(async ({ data }): Promise<{ ok: true }> =>
    runGuarded({
      load: () =>
        db.query.environments.findFirst({
          where: eq(environments.id, data.environmentId),
        }),
      notFoundMessage: "environment not found",
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
            "this environment still has services, stacks or databases — remove them first",
          );
        }

        await db.delete(environments).where(eq(environments.id, environment.id));
        return { ok: true as const };
      },
      target: ({ row }) => ({ id: row.id, name: row.name }),
    }),
  );

/**
 * Duplicate an environment — clones the CONFIGURATION, never the data.
 *
 * Services and stacks are copied config-only: new `id`, status reset to
 * `created`, no current deployment, no domain (the source domain stays with
 * its resource — duplicating it would put two services on the same Traefik
 * route), and an unconfigured webhook (a secret makes no sense once copied,
 * it would become readable again by whoever saw the original). A service's
 * environment variables ARE copied, secrets included — the same decision
 * as PR previews: a clone without `DATABASE_URL` doesn't start.
 *
 * DATABASES are explicitly excluded, and that's the whole point of this
 * change: a database has real data on a real volume. A "config-only" clone
 * would produce an empty database presenting itself as a copy — exactly
 * the misconception this file avoids elsewhere (backups, metrics).
 * `databasesSkipped` reports the count so the screen can say it, instead of
 * hiding it.
 */
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
        // The COPY is the object, not the source it was made from.
        target: ({ result }) => ({
          id: result.environmentId,
          name: result.environmentName,
        }),
      }),
  );
