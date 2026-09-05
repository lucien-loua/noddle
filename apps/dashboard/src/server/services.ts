import { environments, projects, services } from "@noddle/db/schema";
import { ensureRepositoryHook } from "@noddle/git-provider-credentials/hooks";
import { markDeleting } from "@noddle/shared/lifecycle";
import { toResourceSlug, uniqueResourceSlug } from "@noddle/shared/slug";
import {
  connectRepoSchema,
  deleteServiceSchema,
  moveServiceSchema,
  renameServiceSchema,
  updateServiceSettingsSchema,
} from "@noddle/shared/validation/service";
import { createServerFn } from "@tanstack/react-start";
import { and, eq, ne } from "drizzle-orm";
import type { z } from "zod";

import { db } from "@/lib/db.server";
import { env } from "@/lib/env.server";
import { insertProjectEnvironment } from "@/lib/environment.server";
import { guarded, identityTarget } from "@/lib/guarded.server";
import { runGuarded } from "@/lib/permission.server";
import { enqueueDeploy } from "@/lib/queue.server";
import { gitlabHookUrl } from "@/lib/request-origin.server";

interface ServiceSettingsPatch {
  autoDeploy?: boolean;
  buildMethod?: "railpack" | "dockerfile" | "image";
  buildPath?: string | null;
  cleanCache?: boolean;
  deployKeyId?: string | null;
  dockerImage?: string | null;
  gitBranch?: string;
  gitProviderId?: string | null;
  gitRepoFullName?: string | null;
  gitRepoUrl?: string | null;
  gitSubmodules?: boolean;
  publishDirectory?: string | null;
  sourceType?: "git" | "github" | "gitlab" | "docker_image";
  watchPaths?: string[];
}

const CLEARABLE = [
  "buildPath",
  "dockerImage",
  "gitRepoUrl",
  "publishDirectory",
] as const;

const DIRECT = [
  "autoDeploy",
  "buildMethod",
  "cleanCache",
  "deployKeyId",
  "gitBranch",
  "gitProviderId",
  "gitRepoFullName",
  "gitSubmodules",
  "sourceType",
  "watchPaths",
] as const;

function serviceSettingsPatch(
  data: z.infer<typeof updateServiceSettingsSchema>
): ServiceSettingsPatch {
  const patch: Record<string, unknown> = {};
  for (const key of DIRECT) {
    if (data[key] !== undefined) {
      patch[key] = data[key];
    }
  }
  for (const key of CLEARABLE) {
    const value = data[key];
    if (value !== undefined) {
      patch[key] = value === "" ? null : value;
    }
  }
  return patch as ServiceSettingsPatch;
}

export const connectRepo = createServerFn({ method: "POST" })
  .validator(connectRepoSchema)
  .handler(
    async ({
      data,
    }): Promise<{
      environmentId: string;
      projectId: string;
      serviceId: string;
    }> => {
      const outcome = await runGuarded({
        permission: { action: "create", resource: "service" },
        run: async () => {
          let project = await db.query.projects.findFirst({
            where: eq(projects.name, data.projectName),
          });
          if (!project) {
            const [created] = await db
              .insert(projects)
              .values({ name: data.projectName })
              .returning();
            if (!created) {
              throw new Error("could not create project");
            }
            project = created;
          }

          let environment = await db.query.environments.findFirst({
            where: and(
              eq(environments.projectId, project.id),
              eq(environments.name, data.environmentName)
            ),
          });
          if (!environment) {
            environment = await insertProjectEnvironment({
              name: data.environmentName,
              projectId: project.id,
            });
          }

          const wanted = toResourceSlug(data.name) || "app";
          const siblings = await db.query.services.findMany({
            columns: { name: true },
            where: eq(services.environmentId, environment.id),
          });
          const slug = uniqueResourceSlug(
            wanted,
            siblings.map((row) => row.name)
          );

          const [service] = await db
            .insert(services)
            .values({
              buildMethod: "railpack",
              displayName: data.name === slug ? null : data.name,
              environmentId: environment.id,
              gitBranch: "main",
              name: slug,
              port: 3000,
              serverId: data.serverId,
              sourceType: "git",
            })
            .returning();
          if (!service) {
            throw new Error("could not create service");
          }

          return {
            environmentId: environment.id,
            name: service.name,
            projectId: project.id,
            serviceId: service.id,
          };
        },
        target: ({ result }) => ({ id: result.serviceId, name: result.name }),
      });

      return {
        environmentId: outcome.environmentId,
        projectId: outcome.projectId,
        serviceId: outcome.serviceId,
      };
    }
  );

async function armRepositoryHook(serviceId: string): Promise<void> {
  const service = await db.query.services.findFirst({
    where: eq(services.id, serviceId),
    with: { gitProvider: true },
  });
  const provider = service?.gitProvider;
  if (
    provider?.providerType !== "gitlab" ||
    !service?.gitRepoFullName ||
    service.previewOfServiceId !== null
  ) {
    return;
  }
  await ensureRepositoryHook(db, env.appKey, {
    gitProviderId: provider.id,
    hookUrl: gitlabHookUrl(provider.id),
    repositoryFullName: service.gitRepoFullName,
  });
}

export const updateServiceSettings = createServerFn({ method: "POST" })
  .validator(updateServiceSettingsSchema)
  .handler(async ({ data }): Promise<{ ok: true }> =>
    runGuarded({
      ...guarded.service(data.serviceId),
      permission: { action: "deploy", resource: "service" },
      run: async ({ row }) => {
        const patch = serviceSettingsPatch(data);
        if (Object.keys(patch).length > 0) {
          await db.update(services).set(patch).where(eq(services.id, row.id));
        }
        await armRepositoryHook(row.id);
        return { ok: true as const };
      },
      target: identityTarget,
    })
  );

export const renameService = createServerFn({ method: "POST" })
  .validator(renameServiceSchema)
  .handler(async ({ data }): Promise<{ ok: true }> =>
    runGuarded({
      ...guarded.service(data.serviceId),
      permission: { action: "create", resource: "service" },
      run: async ({ row: service }) => {
        await db
          .update(services)
          .set({ displayName: data.displayName || null })
          .where(eq(services.id, service.id));
        return { ok: true as const };
      },
      target: identityTarget,
    })
  );

export const deleteService = createServerFn({ method: "POST" })
  .validator(deleteServiceSchema)
  .handler(async ({ data }): Promise<{ ok: true }> =>
    runGuarded({
      ...guarded.service(data.serviceId),
      confirmName: { expected: (row) => row.name, typed: data.confirmName },
      permission: { action: "delete", resource: "service" },
      run: async ({ row: service }) => {
        await db
          .update(services)
          .set(markDeleting(null))
          .where(eq(services.id, service.id));

        await enqueueDeploy({
          kind: "delete-service",
          serviceId: service.id,
        });
        return { ok: true as const };
      },
      target: identityTarget,
    })
  );

export const moveService = createServerFn({ method: "POST" })
  .validator(moveServiceSchema)
  .handler(async ({ data }): Promise<{ ok: true }> =>
    runGuarded({
      ...guarded.service(data.serviceId),
      permission: { action: "create", resource: "service" },
      run: async ({ row: service }) => {
        const target = await db.query.environments.findFirst({
          where: eq(environments.id, data.environmentId),
        });
        if (!target) {
          throw new Error("environment not found");
        }
        if (target.id === service.environmentId) {
          return { ok: true as const };
        }

        const collision = await db.query.services.findFirst({
          where: and(
            eq(services.environmentId, target.id),
            eq(services.name, service.name),
            ne(services.id, service.id)
          ),
        });
        if (collision) {
          throw new Error(
            `"${service.name}" already exists in the target environment`
          );
        }

        await db
          .update(services)
          .set({ environmentId: target.id })
          .where(eq(services.id, service.id));
        return { ok: true as const };
      },
      target: identityTarget,
    })
  );
