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
import { connectRepoSchema } from "@noddle/shared/validation";
import { createServerFn } from "@tanstack/react-start";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db.server";
import { requirePermission } from "@/lib/permission.server";

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
        throw new Error("création du projet impossible");
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
        throw new Error("création de l'environnement impossible");
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
      throw new Error("création du service impossible");
    }

    return { serviceId: service.id };
  });
