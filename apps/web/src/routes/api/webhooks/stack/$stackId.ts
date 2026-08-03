// Réception d'un webhook GitHub/GitLab pour une pile Compose — même
// mécanisme que le service mono-conteneur, voir ce fichier pour le détail.
import { stacks } from "@noddle/db/schema";
import { decryptSecret, secretContext } from "@noddle/shared/crypto";
import { createFileRoute } from "@tanstack/react-router";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db.server";
import { queueStackDeploy } from "@/lib/deploy-queue.server";
import { env } from "@/lib/env.server";
import { parseWebhookPush, verifyWebhookSignature } from "@/lib/webhook.server";

const UUID = /^[0-9a-f-]{36}$/i;

export const Route = createFileRoute("/api/webhooks/stack/$stackId")({
  server: {
    handlers: {
      POST: async ({ params, request }) => {
        const { stackId } = params;
        if (!UUID.test(stackId)) {
          return new Response("identifiant invalide", { status: 400 });
        }

        const stack = await db.query.stacks.findFirst({
          where: eq(stacks.id, stackId),
        });
        if (!stack?.webhookSecretEncrypted) {
          return new Response("webhook non configuré", { status: 404 });
        }

        const rawBody = await request.text();
        const secret = decryptSecret(
          stack.webhookSecretEncrypted,
          env.appKey,
          secretContext.webhookSecret(stackId)
        );

        if (!verifyWebhookSignature(request.headers, rawBody, secret)) {
          return new Response("signature invalide", { status: 401 });
        }

        const push = parseWebhookPush(rawBody);
        if (!push) {
          return Response.json({ ignored: "payload non reconnu" });
        }

        if (push.branch !== stack.gitBranch) {
          return Response.json({ ignored: `branche ${push.branch}` });
        }

        const { stackDeploymentId } = await queueStackDeploy(stackId, {
          commitSha: push.commitSha,
          trigger: "webhook",
        });
        return Response.json({ stackDeploymentId });
      },
    },
  },
});
