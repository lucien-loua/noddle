import { decryptSecret, secretContext } from "@noddle/crypto";
import { services } from "@noddle/db/schema";
import { createFileRoute } from "@tanstack/react-router";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db.server";
import { env } from "@/lib/env.server";
import type { Resolved } from "@/lib/webhook-intake.server";
import { handleWebhook } from "@/lib/webhook-intake.server";
import { verifyWebhookSignature } from "@/lib/webhook.server";

const UUID = /^[0-9a-f-]{36}$/i;

/**
 * One service's own webhook: the URL says who it is for, so there is no
 * repository to match — the only endpoint whose targets are known up front.
 */
function serviceTarget(serviceId: string) {
  return async (request: Request, rawBody: string): Promise<Resolved> => {
    const service = await db.query.services.findFirst({
      where: eq(services.id, serviceId),
    });
    if (!service?.webhookSecretEncrypted) {
      return {
        refused: { message: "webhook not configured", status: 404 },
      };
    }
    const secret = decryptSecret(
      service.webhookSecretEncrypted,
      env.appKey,
      secretContext.webhookSecret(serviceId),
    );
    if (!verifyWebhookSignature(request.headers, rawBody, secret)) {
      return { refused: { message: "invalid signature", status: 401 } };
    }
    return { services: [service] };
  };
}

export const Route = createFileRoute("/api/webhooks/service/$serviceId")({
  server: {
    handlers: {
      POST: ({ params, request }) => {
        const { serviceId } = params;
        if (!UUID.test(serviceId)) {
          return new Response("invalid id", { status: 400 });
        }
        return handleWebhook(request, serviceTarget(serviceId));
      },
    },
  },
});
