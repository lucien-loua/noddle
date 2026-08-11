import { environments, projects, services } from "@noddle/db/schema";
import { markDeleting } from "@noddle/shared/lifecycle";
import {
  connectRepoSchema,
  deleteServiceSchema,
  moveServiceSchema,
} from "@noddle/shared/validation/service";
import { createServerFn } from "@tanstack/react-start";
import { and, eq, ne } from "drizzle-orm";
import { db } from "@/lib/db.server";
import { requirePermission } from "@/lib/permission.server";
import { enqueueDeploy } from "@/lib/queue.server";

export const connectRepo = createServerFn({ method: "POST" })
  .validator(connectRepoSchema)
  .handler(async ({ data }): Promise<{ serviceId: string }> => {
    await requirePermission({ action: "create", resource: "service" });

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
      const [created] = await db
        .insert(environments)
        .values({ name: data.environmentName, projectId: project.id })
        .returning();
      if (!created) {
        throw new Error("could not create environment");
      }
      environment = created;
    }

    const [service] = await db
      .insert(services)
      .values({
        buildMethod: "nixpacks",
        domain: data.domain,
        environmentId: environment.id,
        gitBranch: data.gitBranch,
        gitRepoUrl: data.gitRepoUrl,
        name: data.name,
        port: data.port,
        serverId: data.serverId,
        sourceType: "git",
      })
      .returning();
    if (!service) {
      throw new Error("could not create service");
    }

    return { serviceId: service.id };
  });

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
  .handler(async ({ data }): Promise<{ ok: true }> => {
    await requirePermission({ action: "delete", resource: "service" });

    const service = await db.query.services.findFirst({
      where: eq(services.id, data.serviceId),
    });
    if (!service) {
      throw new Error("service not found");
    }
    // Re-checked HERE, not only in the dialog box: the operation destroys
    // history, images and variables with no way back.
    if (data.confirmName !== service.name) {
      throw new Error(
        `the name you typed does not match "${service.name}" — deletion cancelled`
      );
    }

    await db
      .update(services)
      .set(markDeleting(null))
      .where(eq(services.id, service.id));

    // Deliberately replayable: `removeService` and the registry purge are
    // idempotent, so an interrupted teardown resumes with another click.
    await enqueueDeploy({ kind: "delete-service", serviceId: service.id });
    return { ok: true };
  });

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
  .handler(async ({ data }): Promise<{ ok: true }> => {
    await requirePermission({ action: "create", resource: "service" });

    const service = await db.query.services.findFirst({
      where: eq(services.id, data.serviceId),
    });
    if (!service) {
      throw new Error("service not found");
    }
    const target = await db.query.environments.findFirst({
      where: eq(environments.id, data.environmentId),
    });
    if (!target) {
      throw new Error("environment not found");
    }
    if (target.id === service.environmentId) {
      return { ok: true };
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
    return { ok: true };
  });
