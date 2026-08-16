import { createFileRoute } from "@tanstack/react-router";
import { handleGitlabWebhook } from "@/lib/gitlab-webhook.server";

/**
 * Hooks added by hand, from before Noddle registered them itself. The
 * connection is not in the URL, so it is found by trying each secret.
 */
export const Route = createFileRoute("/api/webhooks/gitlab")({
  server: {
    handlers: {
      POST: ({ request }) => handleGitlabWebhook(request),
    },
  },
});
