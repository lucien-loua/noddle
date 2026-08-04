// Déclencher un déploiement, et revenir en arrière.
//
// Les deux DÉPOSENT un job et rendent la main. Un déploiement dure des
// minutes ; rien ici ne doit vivre dans le cycle requête/réponse. Et le web
// tourne sur Bun, où `dockerode` à travers un tunnel SSH ne fonctionne pas :
// même en le voulant, il ne pourrait pas faire le travail lui-même.
import { deployments } from "@noddle/db/schema";
import {
  deployRequestSchema,
  rollbackRequestSchema,
} from "@noddle/shared/validation";
import { createServerFn } from "@tanstack/react-start";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db.server";
import { queueServiceDeploy } from "@/lib/deploy-queue.server";
import { requirePermission } from "@/lib/permission.server";
import { enqueueDeploy } from "@/lib/queue.server";

export const triggerDeploy = createServerFn({ method: "POST" })
  .validator(deployRequestSchema)
  .handler(async ({ data }): Promise<{ deploymentId: string }> => {
    await requirePermission({ action: "deploy", resource: "service" });
    // La ligne est créée ICI, pas dans le worker : le bouton doit rendre un
    // identifiant tout de suite pour que l'écran s'abonne au flux de logs
    // avant même que le build commence. Même chemin que le webhook, qui
    // dépose le même genre de ligne sans passer par une session.
    return await queueServiceDeploy(data.serviceId, {
      commitSha: data.commitSha,
      trigger: "manual",
    });
  });

export const triggerRollback = createServerFn({ method: "POST" })
  .validator(rollbackRequestSchema)
  .handler(async ({ data }): Promise<{ imageTag: string }> => {
    await requirePermission({ action: "rollback", resource: "service" });

    // La cible est relue en base plutôt que crue sur parole : le client envoie
    // un identifiant de déploiement, pas un tag d'image. Sans cette lecture,
    // un appel forgé ferait déployer n'importe quelle image présente sur
    // l'hôte.
    const target = await db.query.deployments.findFirst({
      where: and(
        eq(deployments.id, data.deploymentId),
        eq(deployments.serviceId, data.serviceId)
      ),
    });
    if (!target) {
      throw new Error("deployment not found for this service");
    }
    if (!target.imageTag) {
      throw new Error(
        "this deployment produced no image — there is nothing to redeploy"
      );
    }

    // Aucun build : l'image existe déjà sur le serveur. C'est ce qui rend le
    // retour arrière immédiat, et possible vers N'IMPORTE QUELLE version de
    // l'historique — Swarm, lui, ne garde qu'une spec antérieure.
    await enqueueDeploy({
      imageTag: target.imageTag,
      kind: "rollback",
      serviceId: data.serviceId,
    });
    return { imageTag: target.imageTag };
  });
