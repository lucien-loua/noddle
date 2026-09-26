import { environments } from "@noddle/db/schema";
import {
  createEnvironmentSchema,
  duplicateEnvironmentSchema,
  environmentIdSchema,
  renameEnvironmentSchema,
} from "@noddle/shared/validation/project";
import { createServerFn } from "@tanstack/react-start";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db.server";
import { copyEnvironment } from "@/lib/duplicate-environment.server";
import { assertNotDefaultEnvironment } from "@/lib/environment-guard";
import { insertProjectEnvironment } from "@/lib/environment.server";
import { guarded, identityTarget } from "@/lib/guarded.server";
import { runGuarded } from "@/lib/permission.server";
import { requireSession } from "@/lib/session.server";
import {
  environmentForDuplicate,
  environmentNameTaken,
  environmentsHold,
  listProjectEnvironments,
} from "@/lib/team-queries.server";
import { activeTeamId } from "@/lib/team-scope.server";

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
    const rows = await listProjectEnvironments(
      db,
      await activeTeamId(),
      data.projectId
    );
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
        if (
          await environmentNameTaken(
            db,
            await activeTeamId(),
            data.projectId,
            data.name
          )
        ) {
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
        const existing = await environmentNameTaken(
          db,
          await activeTeamId(),
          environment.projectId,
          data.name,
          environment.id
        );
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
        if (
          await environmentsHold(db, await activeTeamId(), [environment.id])
        ) {
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
        load: async () =>
          environmentForDuplicate(db, await activeTeamId(), data.environmentId),
        notFoundMessage: "environment not found",
        permission: { action: "create", resource: "service" },
        run: async ({ row: source }) =>
          copyEnvironment(source, data, await activeTeamId()),
        target: ({ result }) => ({
          id: result.environmentId,
          name: result.environmentName,
        }),
      })
  );
