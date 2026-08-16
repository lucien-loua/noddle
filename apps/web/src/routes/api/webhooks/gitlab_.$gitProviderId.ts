import { createFileRoute } from "@tanstack/react-router";
import { handleGitlabWebhook } from "@/lib/gitlab-webhook.server";

const UUID = /^[0-9a-f-]{36}$/i;

/** Where hooks Noddle registers point: the connection is in the URL. */
export const Route = createFileRoute("/api/webhooks/gitlab_/$gitProviderId")({
  server: {
    handlers: {
      POST: ({ params, request }) => {
        if (!UUID.test(params.gitProviderId)) {
          return new Response("invalid id", { status: 400 });
        }
        return handleGitlabWebhook(request, params.gitProviderId);
      },
    },
  },
});
