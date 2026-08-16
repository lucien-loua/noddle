import { createFileRoute } from "@tanstack/react-router";

import { forgeTargets } from "@/lib/forge-webhook.server";
import { handleWebhook } from "@/lib/webhook-intake.server";

const UUID = /^[0-9a-f-]{36}$/i;

/** Where hooks Noddle registers point. */
export const Route = createFileRoute("/api/webhooks/gitlab_/$gitProviderId")({
  server: {
    handlers: {
      POST: ({ params, request }) => {
        const { gitProviderId } = params;
        if (!UUID.test(gitProviderId)) {
          return new Response("invalid id", { status: 400 });
        }
        return handleWebhook(request, forgeTargets("gitlab", gitProviderId));
      },
    },
  },
});
