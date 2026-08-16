import { gitlabProviders, gitProviders } from "@noddle/db/schema";
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

        // Validated BEFORE it reaches a query, and before any branch can
        // act on it.
        if (!(state && UUID.test(state))) {
          return new Response("missing state", { status: 400 });
        }

        // The guard wraps EVERY path, the refusal included. Deleting the
        // pending row is a write, and a callback URL is guessable — outside
        // this, `?error=x&state=<id>` removes a connection with no session
        // at all. Same reason the failure path below sits inside it: a
        // permission denial must not land in a catch that deletes.
        return await runGuarded({
          permission: { action: "create", resource: "gitProvider" },
          run: async () => {
            // Only a connection that was never authorised can be removed
            // here. Without this, replaying `?error=x&state=<id>` destroys
            // a WORKING connection — and it is a GET, so a link is the
            // whole attack.
            const removePending = async () => {
              const row = await db.query.gitlabProviders.findFirst({
                where: eq(gitlabProviders.gitProviderId, state),
              });
              if (row && !row.accessTokenEncrypted) {
                await db.delete(gitProviders).where(eq(gitProviders.id, state));
              }
            };

            if (denied) {
              await removePending();
              return new Response(
                `GitLab refused the authorisation (${denied}). The connection was removed — start it again.`,
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
              // The code is single use. Retrying this URL cannot work, so
              // the pending row goes rather than being left looking
              // connected when it is not.
              const detail =
                error instanceof Error ? error.message : String(error);
              await removePending();
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
