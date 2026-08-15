import { environments, projects, services } from "@noddle/db/schema";
import { markDeleting } from "@noddle/shared/lifecycle";
import {
  connectRepoSchema,
  deleteServiceSchema,
  moveServiceSchema,
  updateServiceSettingsSchema,
} from "@noddle/shared/validation/service";
import { createServerFn } from "@tanstack/react-start";
import { and, eq, ne } from "drizzle-orm";
import type { z } from "zod";
import { db } from "@/lib/db.server";
import { insertProjectEnvironment } from "@/lib/environment.server";
import { runGuarded } from "@/lib/permission.server";
import { enqueueDeploy } from "@/lib/queue.server";

interface ServiceSettingsPatch {
  autoDeploy?: boolean;
  buildMethod?: "nixpacks" | "dockerfile" | "image";
  buildPath?: string | null;
  cleanCache?: boolean;
  deployKeyId?: string | null;
  dockerImage?: string | null;
  gitBranch?: string;
  gitProviderId?: string | null;
  gitRepoUrl?: string | null;
  gitSubmodules?: boolean;
  publishDirectory?: string | null;
  sourceType?: "git" | "github" | "gitlab" | "docker_image";
  watchPaths?: string[];
}

/** Fields where an empty string from a form means "clear", not "invalid". */
const CLEARABLE = [
  "buildPath",
  "dockerImage",
  "gitRepoUrl",
  "publishDirectory",
] as const;

/** Fields copied across as-is when present. */
const DIRECT = [
  "autoDeploy",
  "buildMethod",
  "cleanCache",
  "deployKeyId",
  "gitBranch",
  "gitProviderId",
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
      // The Service is the object recorded, not the Project or Environment
      // this may also have created: those are find-or-create side effects,
      // the Service is what the user asked for.
      const guarded = await runGuarded({
        permission: { action: "create", resource: "service" },
        run: async () => {
          // Find-or-create BY NAME: a lone administrator at their dashboard types
          // the same project name to file a second service under it, they
          // shouldn't need to know a hidden id to land back on the same row.
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

          const [service] = await db
            .insert(services)
            .values({
              buildMethod: "nixpacks",
              environmentId: environment.id,
              gitBranch: "main",
              name: data.name,
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
        environmentId: guarded.environmentId,
        projectId: guarded.projectId,
        serviceId: guarded.serviceId,
      };
    }
  );

export const updateServiceSettings = createServerFn({ method: "POST" })
  .validator(updateServiceSettingsSchema)
  .handler(
    async ({ data }): Promise<{ ok: true }> =>
      runGuarded({
        load: () =>
          db.query.services.findFirst({
            where: eq(services.id, data.serviceId),
          }),
        notFoundMessage: "service not found",
        permission: { action: "deploy", resource: "service" },
        run: async ({ row }) => {
          const patch = serviceSettingsPatch(data);
          if (Object.keys(patch).length > 0) {
            await db.update(services).set(patch).where(eq(services.id, row.id));
          }
          return { ok: true as const };
        },
        target: ({ row }) => ({ id: row.id, name: row.name }),
      })
  );

/**
 * Delete a service — the path the product was missing.
 *
 * Nothing is destroyed HERE: the server function marks the intent and
 * queues the work. The teardown needs SSH and the Docker API, so it needs
 * the worker — and above all, it must go through the SAME queue as
 * deployments. Without that, a deletion and a deployment of the same
 * service would race, and the latter would recreate the Swarm service the
 * former just tore down.
 *
 * The `deleting` state isn't cosmetic: the Swarm service must disappear
 * BEFORE the row. As long as it's running, Traefik routes to it — a screen
 * announcing the deletion while the application is still responding would
 * be the worst of both possible lies.
 */
export const deleteService = createServerFn({ method: "POST" })
  .validator(deleteServiceSchema)
  .handler(
    async ({ data }): Promise<{ ok: true }> =>
      runGuarded({
        // Re-checked by the helper, not only in the dialog box: the
        // operation destroys history, images and variables with no way
        // back.
        confirmName: { expected: (row) => row.name, typed: data.confirmName },
        load: () =>
          db.query.services.findFirst({
            where: eq(services.id, data.serviceId),
          }),
        notFoundMessage: "service not found",
        permission: { action: "delete", resource: "service" },
        run: async ({ row: service }) => {
          await db
            .update(services)
            .set(markDeleting(null))
            .where(eq(services.id, service.id));

          // Deliberately replayable: `removeService` and the registry purge are
          // idempotent, so an interrupted teardown resumes with another click.
          await enqueueDeploy({
            kind: "delete-service",
            serviceId: service.id,
          });
          return { ok: true as const };
        },
        target: ({ row }) => ({ id: row.id, name: row.name }),
      })
  );

/**
 * Move a service to another project/environment — a FILING operation, not
 * a deployment. The running container doesn't move, the server that built
 * it doesn't move, its webhook keeps the same URL (addressed by the
 * service's id, unchanged): only the row's classification changes. No job,
 * therefore — nothing on the worker side needs to know about it.
 *
 * Stacks and databases stay out of scope: `moveServiceSchema` only carries
 * a `serviceId`, a decision made to keep this change's size in check rather
 * than improvised along the way.
 */
export const moveService = createServerFn({ method: "POST" })
  .validator(moveServiceSchema)
  .handler(
    async ({ data }): Promise<{ ok: true }> =>
      runGuarded({
        load: () =>
          db.query.services.findFirst({
            where: eq(services.id, data.serviceId),
          }),
        notFoundMessage: "service not found",
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
        target: ({ row }) => ({ id: row.id, name: row.name }),
      })
  );
