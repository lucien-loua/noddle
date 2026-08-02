// Déclencher un déploiement, et revenir en arrière.
//
// Les deux DÉPOSENT un job et rendent la main. Un déploiement dure des
// minutes ; rien ici ne doit vivre dans le cycle requête/réponse. Et le web
// tourne sur Bun, où `dockerode` à travers un tunnel SSH ne fonctionne pas :
// même en le voulant, il ne pourrait pas faire le travail lui-même.
import { deployments, services } from "@noddle/db/schema";
import {
  deployRequestSchema,
  rollbackRequestSchema,
} from "@noddle/shared/validation";
import { createServerFn } from "@tanstack/react-start";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db.server";
import { enqueueDeploy } from "@/lib/queue.server";
import { requireSession } from "@/lib/session.server";

export const triggerDeploy = createServerFn({ method: "POST" })
  .validator(deployRequestSchema)
  .handler(async ({ data }): Promise<{ deploymentId: string }> => {
    await requireSession();

    const service = await db.query.services.findFirst({
      where: eq(services.id, data.serviceId),
    });
    if (!service) {
      throw new Error("service introuvable");
    }

    // La ligne est créée ICI, pas dans le worker : le bouton doit rendre un
    // identifiant tout de suite pour que l'écran s'abonne au flux de logs
    // avant même que le build commence.
    const [created] = await db
      .insert(deployments)
      .values({
        commitSha: data.commitSha ?? null,
        serviceId: service.id,
        status: "queued",
        trigger: "manual",
      })
      .returning();
    if (!created) {
      throw new Error("création du déploiement impossible");
    }

    await db
      .update(services)
      .set({ status: "deploying" })
      .where(eq(services.id, service.id));

    await enqueueDeploy({ deploymentId: created.id, kind: "deploy" });
    return { deploymentId: created.id };
  });

export const triggerRollback = createServerFn({ method: "POST" })
  .validator(rollbackRequestSchema)
  .handler(async ({ data }): Promise<{ imageTag: string }> => {
    await requireSession();

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
      throw new Error("déploiement introuvable pour ce service");
    }
    if (!target.imageTag) {
      throw new Error(
        "ce déploiement n'a produit aucune image : il n'y a rien à rejouer"
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
