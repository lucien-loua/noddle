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
import { guarded, identityTarget } from "@/lib/guarded.server";
import { runGuarded } from "@/lib/permission.server";
import { requireSession } from "@/lib/session.server";

export interface ProjectView {
  createdAt: string;
  description: string | null;
  id: string;
  name: string;
}

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

export const createProject = createServerFn({ method: "POST" })
  .validator(createProjectSchema)
  .handler(
    async ({ data }): Promise<{ environmentId: string; projectId: string }> =>
      runGuarded({
        permission: { action: "create", resource: "service" },
        run: async () => {
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
      ...guarded.project(data.projectId),
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
      target: identityTarget,
    })
  );

export const deleteProject = createServerFn({ method: "POST" })
  .validator(projectIdSchema)
  .handler(async ({ data }): Promise<{ ok: true }> =>
    runGuarded({
      ...guarded.project(data.projectId),
      permission: { action: "delete", resource: "service" },
      run: async ({ row: project }) => {
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
      target: identityTarget,
    })
  );
