import { createFileRoute } from "@tanstack/react-router";
import { forgeTargets } from "@/lib/forge-webhook.server";
import { handleWebhook } from "@/lib/webhook-intake.server";

/** Apps created before the URL carried the connection. */
export const Route = createFileRoute("/api/webhooks/github")({
  server: {
    handlers: {
      POST: ({ request }) => handleWebhook(request, forgeTargets("github")),
    },
  },
});
