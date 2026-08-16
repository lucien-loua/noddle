import { createFileRoute } from "@tanstack/react-router";
import { forgeTargets } from "@/lib/forge-webhook.server";
import { handleWebhook } from "@/lib/webhook-intake.server";

const UUID = /^[0-9a-f-]{36}$/i;

/** What new App manifests declare as their hook URL. */
export const Route = createFileRoute("/api/webhooks/github_/$gitProviderId")({
  server: {
    handlers: {
      POST: ({ params, request }) => {
        const { gitProviderId } = params;
        if (!UUID.test(gitProviderId)) {
          return new Response("invalid id", { status: 400 });
        }
        return handleWebhook(request, forgeTargets("github", gitProviderId));
      },
    },
  },
});
