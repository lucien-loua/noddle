// Réception d'un webhook GitHub/GitLab pour un service mono-conteneur.
//
// Pas de session ici — l'authentification est la signature HMAC (ou le jeton
// GitLab), pas un cookie. C'est pour ça que ce chemin ne passe PAS par
// `queueServiceDeploy` via une server function classique : celles-ci exigent
// `requireSession()`. Le helper est appelé directement.
import { services } from "@noddle/db/schema";
import { decryptSecret, secretContext } from "@noddle/shared/crypto";
import { createFileRoute } from "@tanstack/react-router";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db.server";
import { queueServiceDeploy } from "@/lib/deploy-queue.server";
import { env } from "@/lib/env.server";
import { parseWebhookPush, verifyWebhookSignature } from "@/lib/webhook.server";

const UUID = /^[0-9a-f-]{36}$/i;

export const Route = createFileRoute("/api/webhooks/service/$serviceId")({
  server: {
    handlers: {
      POST: async ({ params, request }) => {
        const { serviceId } = params;
        if (!UUID.test(serviceId)) {
          return new Response("identifiant invalide", { status: 400 });
        }

        const service = await db.query.services.findFirst({
          where: eq(services.id, serviceId),
        });
        if (!service?.webhookSecretEncrypted) {
          return new Response("webhook non configuré", { status: 404 });
        }

        // Le corps brut EXACT sert à la vérification de signature — le
        // reparser en JSON avant de vérifier romprait la comparaison d'octets.
        const rawBody = await request.text();
        const secret = decryptSecret(
          service.webhookSecretEncrypted,
          env.appKey,
          secretContext.webhookSecret(serviceId)
        );

        if (!verifyWebhookSignature(request.headers, rawBody, secret)) {
          return new Response("signature invalide", { status: 401 });
        }

        const push = parseWebhookPush(rawBody);
        if (!push) {
          // 200, pas 4xx : un event autre qu'un push de branche (tag, etc.)
          // n'est pas une erreur, juste rien à faire.
          return Response.json({ ignored: "payload non reconnu" });
        }

        if (!service.gitBranch || push.branch !== service.gitBranch) {
          return Response.json({ ignored: `branche ${push.branch}` });
        }

        const { deploymentId } = await queueServiceDeploy(serviceId, {
          commitSha: push.commitSha,
          trigger: "webhook",
        });
        return Response.json({ deploymentId });
      },
    },
  },
});
