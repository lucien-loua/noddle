import { databases, projects, services, stacks } from "@noddle/db/schema";
import {
  createProjectSchema,
  projectIdSchema,
  renameProjectSchema,
} from "@noddle/shared/validation/project";
import { createServerFn } from "@tanstack/react-start";
import { and, eq, inArray, ne } from "drizzle-orm";

import { db } from "@/lib/db.server";
import { insertProjectEnvironment } from "@/lib/environment.server";
import { runGuarded } from "@/lib/permission.server";
import { requireSession } from "@/lib/session.server";

export interface ProjectView {
  /** ISO timestamp — the card reads it as "Created 2 days ago". */
  createdAt: string;
  description: string | null;
  id: string;
  name: string;
}

/**
 * ALL projects, even those that don't carry a single resource yet.
 *
 * Distinct from `getDashboardGroups`, which builds its groups from
 * SERVICES: an empty project doesn't show up there at all. As long as a
 * project could only come into being through connecting a resource, this
 * went unnoticed; since `createProject`, a project just created would be
 * invisible on the screen that created it.
 */
export const getProjects = createServerFn({ method: "GET" }).handler(
  async (): Promise<ProjectView[]> => {
    await requireSession();
    const rows = await db.query.projects.findMany({ orderBy: projects.name });
    return rows.map((p) => ({
      createdAt: p.createdAt.toISOString(),
      description: p.description,
      id: p.id,
      name: p.name,
    }));
  }
);

/**
 * A project is born WITH an environment, never alone.
 *
 * `/projects/<id>` redirects to the project's first environment; with none,
 * it would render a 404 on a project just created — the screen would lie
 * about what exists. That first environment is the default: it cannot be
 * deleted or renamed. Common convention for this kind of product: we create
 * "production" by default.
 */
export const createProject = createServerFn({ method: "POST" })
  .validator(createProjectSchema)
  .handler(
    async ({ data }): Promise<{ environmentId: string; projectId: string }> =>
      // The Project is the object, and it does not exist until `run` has
      // made it — the target reads the result.
      runGuarded({
        permission: { action: "create", resource: "service" },
        run: async () => {
          // The name has been unique in the database since migration 0028, but
          // we reject it here with a readable message rather than letting a
          // constraint violation bubble up.
          const existing = await db.query.projects.findFirst({
            where: eq(projects.name, data.name),
          });
          if (existing) {
            throw new Error(`a project called "${data.name}" already exists`);
          }

          const [project] = await db
            .insert(projects)
            .values({ description: data.description, name: data.name })
            .returning();
          if (!project) {
            throw new Error("could not create project");
          }

          const environment = await insertProjectEnvironment({
            name: data.environmentName,
            projectId: project.id,
          });

          return {
            environmentId: environment.id,
            projectId: project.id,
            projectName: project.name,
          };
        },
        target: ({ result }) => ({
          id: result.projectId,
          name: result.projectName,
        }),
      })
  );

export const renameProject = createServerFn({ method: "POST" })
  .validator(renameProjectSchema)
  .handler(async ({ data }): Promise<{ ok: true }> =>
    runGuarded({
      load: () =>
        db.query.projects.findFirst({
          where: eq(projects.id, data.projectId),
        }),
      notFoundMessage: "project not found",
      permission: { action: "create", resource: "service" },
      run: async ({ row: project }) => {
        const clash = await db.query.projects.findFirst({
          where: and(eq(projects.name, data.name), ne(projects.id, project.id)),
        });
        if (clash) {
          throw new Error(`a project called "${data.name}" already exists`);
        }

        await db
          .update(projects)
          .set({ description: data.description, name: data.name })
          .where(eq(projects.id, project.id));
        return { ok: true as const };
      },
      // The name recorded is the one BEFORE the rename: the audit line
      // says what was acted on, not what it became.
      target: ({ row }) => ({ id: row.id, name: row.name }),
    })
  );

/**
 * Delete a project — refused if it still carries the slightest resource.
 *
 * `environments.project_id` is `cascade`, so a plain DELETE would drag down
 * the environments AND, transitively, the services, stacks and databases
 * they contain — without ever removing a single container from the
 * cluster. We'd end up with live Swarm services that no row talks about
 * anymore: Traefik would keep routing to applications the dashboard no
 * longer knows about. Same guard as `deleteEnvironment`, one layer up, for
 * a more serious reason.
 */
export const deleteProject = createServerFn({ method: "POST" })
  .validator(projectIdSchema)
  .handler(async ({ data }): Promise<{ ok: true }> =>
    runGuarded({
      load: () =>
        db.query.projects.findFirst({
          where: eq(projects.id, data.projectId),
          with: { environments: true },
        }),
      notFoundMessage: "project not found",
      permission: { action: "delete", resource: "service" },
      run: async ({ row: project }) => {
        // `inArray` with an EMPTY list produces an `IN ()` that Postgres
        // rejects: a project with no environment therefore skips the check,
        // which is also just common sense — it can't contain anything.
        const environmentIds = project.environments.map((e) => e.id);
        if (environmentIds.length > 0) {
          const [service, stack, database] = await Promise.all([
            db.query.services.findFirst({
              where: inArray(services.environmentId, environmentIds),
            }),
            db.query.stacks.findFirst({
              where: inArray(stacks.environmentId, environmentIds),
            }),
            db.query.databases.findFirst({
              where: inArray(databases.environmentId, environmentIds),
            }),
          ]);
          if (service || stack || database) {
            throw new Error(
              "this project still has services, stacks or databases: remove them first"
            );
          }
        }

        await db.delete(projects).where(eq(projects.id, project.id));
        return { ok: true as const };
      },
      target: ({ row }) => ({ id: row.id, name: row.name }),
    })
  );
