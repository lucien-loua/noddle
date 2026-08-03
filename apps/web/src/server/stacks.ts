// Piles Compose : connecter, déployer, revenir en arrière.
//
// Même partage de responsabilités que `services.ts` / `deployments.ts` : le
// web dépose des lignes et des jobs, jamais un build ou une bascule Swarm —
// il tourne sur Bun, où `dockerode` à travers un tunnel SSH ne fonctionne pas.
import {
  environments,
  projects,
  stackDeployments,
  stacks,
} from "@noddle/db/schema";
import {
  connectStackSchema,
  stackDeployRequestSchema,
  stackRollbackRequestSchema,
} from "@noddle/shared/validation";
import { createServerFn } from "@tanstack/react-start";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db.server";
import { enqueueDeploy } from "@/lib/queue.server";
import { requireSession } from "@/lib/session.server";
import type { DeploymentSummary } from "@/server/dashboard";

export const connectStack = createServerFn({ method: "POST" })
  .validator(connectStackSchema)
  .handler(async ({ data }): Promise<{ stackId: string }> => {
    await requireSession();

    // Retrouve-ou-crée par nom, exactement comme `connectRepo` : un même
    // projet/environnement accueille plusieurs services ET plusieurs piles.
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

    const [stack] = await db
      .insert(stacks)
      .values({
        composeFilePath: data.composeFilePath,
        domain: data.domain,
        environmentId: environment.id,
        gitBranch: data.gitBranch,
        gitRepoUrl: data.gitRepoUrl,
        name: data.name,
        port: data.port,
        publicService: data.publicService,
        serverId: data.serverId,
      })
      .returning();
    if (!stack) {
      throw new Error("création de la pile impossible");
    }

    return { stackId: stack.id };
  });

export const triggerStackDeploy = createServerFn({ method: "POST" })
  .validator(stackDeployRequestSchema)
  .handler(async ({ data }): Promise<{ stackDeploymentId: string }> => {
    await requireSession();

    const stack = await db.query.stacks.findFirst({
      where: eq(stacks.id, data.stackId),
    });
    if (!stack) {
      throw new Error("pile introuvable");
    }

    // Créée ICI, pas dans le worker : le bouton doit rendre un identifiant
    // tout de suite pour que l'écran s'abonne au flux de logs avant même que
    // le clone commence.
    const [created] = await db
      .insert(stackDeployments)
      .values({ stackId: stack.id, status: "queued", trigger: "manual" })
      .returning();
    if (!created) {
      throw new Error("création du déploiement de pile impossible");
    }

    await db
      .update(stacks)
      .set({ status: "deploying" })
      .where(eq(stacks.id, stack.id));

    await enqueueDeploy({
      kind: "deploy-stack",
      stackDeploymentId: created.id,
    });
    return { stackDeploymentId: created.id };
  });

export const triggerStackRollback = createServerFn({ method: "POST" })
  .validator(stackRollbackRequestSchema)
  .handler(async ({ data }): Promise<{ ok: true }> => {
    await requireSession();

    // Relu en base plutôt que cru sur parole : le client envoie un
    // identifiant de déploiement, pas un texte compose — même raison que
    // `triggerRollback` pour le chemin mono-service.
    const target = await db.query.stackDeployments.findFirst({
      where: and(
        eq(stackDeployments.id, data.sourceDeploymentId),
        eq(stackDeployments.stackId, data.stackId)
      ),
    });
    if (!target) {
      throw new Error("déploiement introuvable pour cette pile");
    }
    if (!target.composeSource) {
      throw new Error(
        "ce déploiement n'a rien produit : il n'y a rien à rejouer"
      );
    }

    await enqueueDeploy({
      kind: "rollback-stack",
      sourceDeploymentId: data.sourceDeploymentId,
      stackId: data.stackId,
    });
    return { ok: true };
  });

function toSummary(
  row: typeof stackDeployments.$inferSelect
): DeploymentSummary {
  return {
    commitSha: row.commitSha,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    id: row.id,
    // `DeploymentHistory` ne s'en sert que pour décider si un « Rejouer » a un
    // sens : une pile s'y prête dès qu'un texte compose a été enregistré,
    // qu'elle ait construit une image ou seulement pointé vers `image:`.
    imageTag: row.composeSource ? row.id : null,
    status: row.status,
    trigger: row.trigger,
  };
}

export const getStackDeployments = createServerFn({ method: "GET" })
  .validator((data: { stackId: string }) => data)
  .handler(async ({ data }): Promise<DeploymentSummary[]> => {
    await requireSession();
    const rows = await db.query.stackDeployments.findMany({
      limit: 50,
      orderBy: desc(stackDeployments.createdAt),
      where: eq(stackDeployments.stackId, data.stackId),
    });
    return rows.map(toSummary);
  });
