// Connecter un dépôt — la porte d'entrée qui manquait.
//
// Chaque vérification de ce dépôt, depuis la Phase 1, a créé ses services par
// SQL directement : cette server function est la première fois que ce chemin
// existe pour de vrai, depuis le dashboard.
//
// `sourceType` n'est PAS un choix laissé à l'utilisateur ici : le worker ne
// sait construire qu'un dépôt git via nixpacks aujourd'hui. Exposer
// `docker_image` ou `compose` dans ce formulaire ferait miroiter un chemin de
// déploiement qui échouerait à la première tentative.
import { environments, projects, services } from "@noddle/db/schema";
import {
  connectRepoSchema,
  deleteServiceSchema,
} from "@noddle/shared/validation";
import { createServerFn } from "@tanstack/react-start";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db.server";
import { requirePermission } from "@/lib/permission.server";
import { enqueueDeploy } from "@/lib/queue.server";

export const connectRepo = createServerFn({ method: "POST" })
  .validator(connectRepoSchema)
  .handler(async ({ data }): Promise<{ serviceId: string }> => {
    await requirePermission({ action: "create", resource: "service" });

    // Retrouve-ou-crée par NOM : un administrateur seul devant son dashboard
    // tape le même nom de projet pour y ranger un second service, il n'a pas
    // à connaître un identifiant caché pour retomber sur la même ligne.
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
 * Supprimer un service — le chemin qui manquait au produit.
 *
 * Rien n'est détruit ICI : la server function marque l'intention et dépose le
 * travail. Le démontage a besoin de SSH et de l'API Docker, donc du worker —
 * et surtout, il doit passer par la MÊME file que les déploiements. Sans ça,
 * une suppression et un déploiement du même service se croiseraient, et le
 * second recréerait le service Swarm que la première vient de retirer.
 *
 * L'état `deleting` n'est pas cosmétique : le service Swarm doit disparaître
 * AVANT la ligne. Tant qu'il tourne, Traefik y route — un écran qui annoncerait
 * la suppression pendant que l'application répond encore serait le pire des
 * deux mensonges possibles.
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
    // Revérifié ICI, pas seulement dans la boîte de dialogue : l'opération
    // détruit l'historique, les images et les variables sans retour possible.
    if (data.confirmName !== service.name) {
      throw new Error(
        `the name you typed does not match "${service.name}" — deletion cancelled`
      );
    }

    await db
      .update(services)
      .set({ status: "deleting" })
      .where(eq(services.id, service.id));

    // Rejouable à dessein : `removeService` et la purge du registre sont
    // idempotents, donc un démontage interrompu se relance en recliquant.
    await enqueueDeploy({ kind: "delete-service", serviceId: service.id });
    return { ok: true };
  });
