import { gitlabProviders, gitProviders } from "@noddle/db/schema";
import { exchangeCode } from "@noddle/git-provider/gitlab";
import { createFileRoute } from "@tanstack/react-router";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db.server";
import { gitlabAppFor, saveGitlabTokens } from "@/lib/gitlab.server";
import { runGuarded } from "@/lib/permission.server";

const UUID = /^[0-9a-f-]{36}$/i;

const removePending = async (gitProviderId: string) => {
  const row = await db.query.gitlabProviders.findFirst({
    where: eq(gitlabProviders.gitProviderId, gitProviderId),
  });
  if (row && !row.accessTokenEncrypted) {
    await db.delete(gitProviders).where(eq(gitProviders.id, gitProviderId));
  }
};

export const Route = createFileRoute("/api/git-providers/gitlab/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const denied = url.searchParams.get("error");

        if (!(state && UUID.test(state))) {
          return new Response("missing state", { status: 400 });
        }

        return await runGuarded({
          permission: { action: "create", resource: "gitProvider" },
          run: async () => {
            if (denied) {
              await removePending(state);
              return new Response(
                `GitLab refused the authorisation (${denied}). The connection was removed. Start it again.`,
                { headers: { "content-type": "text/plain" }, status: 400 }
              );
            }

            if (!code) {
              return new Response("missing code", { status: 400 });
            }

            try {
              const { app } = await gitlabAppFor(state);
              const tokens = await exchangeCode(app, code);
              await saveGitlabTokens(state, tokens);
            } catch (error) {
              const detail =
                error instanceof Error ? error.message : String(error);
              await removePending(state);
              return new Response(
                `Could not finish connecting GitLab, and the code cannot be reused. Start the connection again.\n\n${detail}`,
                { headers: { "content-type": "text/plain" }, status: 400 }
              );
            }

            return Response.redirect(
              new URL("/git-providers", request.url),
              303
            );
          },
          target: () => ({ id: state, name: "gitlab" }),
        });
      },
    },
  },
});
