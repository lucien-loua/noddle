import { decryptSecret, secretContext } from "@noddle/crypto";
import { stacks } from "@noddle/db/schema";
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
          return new Response("invalid id", { status: 400 });
        }

        const stack = await db.query.stacks.findFirst({
          where: eq(stacks.id, stackId),
        });
        if (!stack?.webhookSecretEncrypted) {
          return new Response("webhook not configured", { status: 404 });
        }

        const rawBody = await request.text();
        const secret = decryptSecret(
          stack.webhookSecretEncrypted,
          env.appKey,
          secretContext.webhookSecret(stackId)
        );

        if (!verifyWebhookSignature(request.headers, rawBody, secret)) {
          return new Response("invalid signature", { status: 401 });
        }

        const push = parseWebhookPush(rawBody);
        if (!push) {
          return Response.json({ ignored: "unrecognized payload" });
        }

        if (push.branch !== stack.gitBranch) {
          return Response.json({ ignored: `branch ${push.branch}` });
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
