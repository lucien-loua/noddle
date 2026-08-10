import { services } from "@noddle/db/schema";
import { decryptSecret, secretContext } from "@noddle/shared/crypto";
import { createFileRoute } from "@tanstack/react-router";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db.server";
import { queueServiceDeploy } from "@/lib/deploy-queue.server";
import { env } from "@/lib/env.server";
import { destroyPreview, ensurePreview } from "@/lib/preview.server";
import {
  parseWebhookPullRequest,
  parseWebhookPush,
  verifyWebhookSignature,
} from "@/lib/webhook.server";

const UUID = /^[0-9a-f-]{36}$/i;

export const Route = createFileRoute("/api/webhooks/service/$serviceId")({
  server: {
    handlers: {
      POST: async ({ params, request }) => {
        const { serviceId } = params;
        if (!UUID.test(serviceId)) {
          return new Response("invalid id", { status: 400 });
        }

        const service = await db.query.services.findFirst({
          where: eq(services.id, serviceId),
        });
        if (!service?.webhookSecretEncrypted) {
          return new Response("webhook not configured", { status: 404 });
        }

        // The EXACT raw body is used for signature verification — reparsing
        // it as JSON before verifying would break the byte comparison.
        const rawBody = await request.text();
        const secret = decryptSecret(
          service.webhookSecretEncrypted,
          env.appKey,
          secretContext.webhookSecret(serviceId)
        );

        if (!verifyWebhookSignature(request.headers, rawBody, secret)) {
          return new Response("invalid signature", { status: 401 });
        }

        // The SAME webhook carries both events: a push deploys the
        // configured branch, a pull request manages its preview. The two
        // payloads are disjoint — a push has no `action`, a PR has no
        // `ref` — so the read order doesn't matter.
        const pr = parseWebhookPullRequest(rawBody);
        if (pr) {
          // A PR coming from a FORK gets NO preview. A preview inherits the
          // parent's variables, secrets included; running outside code with
          // them would leak them.
          if (pr.fromFork) {
            return Response.json({ ignored: "pull request from a fork" });
          }
          const outcome = pr.closed
            ? await destroyPreview({
                parentServiceId: serviceId,
                prNumber: pr.number,
              })
            : await ensurePreview({
                commitSha: pr.commitSha,
                headBranch: pr.headBranch,
                parentServiceId: serviceId,
                prNumber: pr.number,
              });
          return Response.json(outcome);
        }

        const push = parseWebhookPush(rawBody);
        if (!push) {
          // 200, not 4xx: an event other than a branch push (tag, etc.)
          // isn't an error, just nothing to do.
          return Response.json({ ignored: "unrecognized payload" });
        }

        if (!service.gitBranch || push.branch !== service.gitBranch) {
          return Response.json({ ignored: `branch ${push.branch}` });
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
