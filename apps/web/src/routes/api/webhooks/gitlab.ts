import { createFileRoute } from "@tanstack/react-router";

import { forgeTargets } from "@/lib/forge-webhook.server";
import { handleWebhook } from "@/lib/webhook-intake.server";

/** Hooks added by hand, without the connection in the URL. */
export const Route = createFileRoute("/api/webhooks/gitlab")({
  server: {
    handlers: {
      POST: ({ request }) => handleWebhook(request, forgeTargets("gitlab")),
    },
  },
});
