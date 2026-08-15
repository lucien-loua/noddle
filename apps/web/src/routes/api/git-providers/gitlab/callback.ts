import { gitProviders } from "@noddle/db/schema";
import { exchangeCode } from "@noddle/git-provider/gitlab";
import { createFileRoute } from "@tanstack/react-router";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db.server";
import { gitlabAppFor, saveGitlabTokens } from "@/lib/gitlab.server";
import { runGuarded } from "@/lib/permission.server";

const UUID = /^[0-9a-f-]{36}$/i;

/**
 * Where GitLab returns the browser after the operator authorised.
 *
 * A GET that writes, which GitLab's redirect dictates — guarded on the
 * permission like every other write, because a callback URL is guessable
 * and `state` alone is not authorisation.
 */
export const Route = createFileRoute("/api/git-providers/gitlab/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const denied = url.searchParams.get("error");

        // GitLab reports a refused authorisation here rather than by not
        // coming back, so it needs saying — otherwise the connection sits
        // half-created with no explanation.
        if (denied) {
          await db.delete(gitProviders).where(eq(gitProviders.id, state ?? ""));
          return new Response(
            `GitLab refused the authorisation (${denied}). The connection was removed — start it again.`,
            { headers: { "content-type": "text/plain" }, status: 400 }
          );
        }

        if (!(code && state && UUID.test(state))) {
          return new Response("missing code or state", { status: 400 });
        }

        try {
          await runGuarded({
            permission: { action: "create", resource: "gitProvider" },
            run: async () => {
              const { app } = await gitlabAppFor(state);
              const tokens = await exchangeCode(app, code);
              await saveGitlabTokens(state, tokens);
            },
            target: () => ({ id: state, name: "gitlab" }),
          });
        } catch (err) {
          // The code is single use. Retrying this URL cannot work, so the
          // pending row goes rather than being left in a state that looks
          // connected and is not.
          const detail = err instanceof Error ? err.message : String(err);
          await db.delete(gitProviders).where(eq(gitProviders.id, state));
          return new Response(
            `Could not finish connecting GitLab, and the code cannot be reused. Start the connection again.\n\n${detail}`,
            { headers: { "content-type": "text/plain" }, status: 400 }
          );
        }

        return Response.redirect(new URL("/git-providers", request.url), 303);
      },
    },
  },
});
