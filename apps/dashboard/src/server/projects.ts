import { projects } from "@noddle/db/schema";
import {
  createProjectSchema,
  projectIdSchema,
  renameProjectSchema,
} from "@noddle/shared/validation/project";
import { createServerFn } from "@tanstack/react-start";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db.server";
import { insertProjectEnvironment } from "@/lib/environment.server";
import { guarded, identityTarget } from "@/lib/guarded.server";
import { runGuarded } from "@/lib/permission.server";
import { requireSession } from "@/lib/session.server";
import {
  environmentsHold,
  listProjects,
  projectNameTaken,
} from "@/lib/team-queries.server";
import { activeTeamId } from "@/lib/team-scope.server";

export interface ProjectView {
  createdAt: string;
  description: string | null;
  id: string;
  name: string;
}

export const getProjects = createServerFn({ method: "GET" }).handler(
  async (): Promise<ProjectView[]> => {
    await requireSession();
    const rows = await listProjects(db, await activeTeamId());
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
          const teamId = await activeTeamId();
          if (await projectNameTaken(db, teamId, data.name)) {
            throw new Error(`a project called "${data.name}" already exists`);
          }

          const [project] = await db
            .insert(projects)
            .values({ description: data.description, name: data.name, teamId })
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
        if (await projectNameTaken(db, project.teamId, data.name, project.id)) {
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
        if (await environmentsHold(db, project.teamId, environmentIds)) {
          throw new Error(
            "this project still has services, stacks or databases: remove them first"
          );
        }

        await db.delete(projects).where(eq(projects.id, project.id));
        return { ok: true as const };
      },
      target: identityTarget,
    })
  );
