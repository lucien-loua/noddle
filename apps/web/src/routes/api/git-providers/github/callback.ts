import { githubProviders, gitProviders } from "@noddle/db/schema";
import { exchangeManifestCode } from "@noddle/git-provider/github";
import { createFileRoute } from "@tanstack/react-router";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db.server";
import { runGuarded } from "@/lib/permission.server";
import { saveCreatedApp } from "@/server/git-providers";

const UUID = /^[0-9a-f-]{36}$/i;
const NUMERIC = /^[0-9]{1,20}$/;

/**
 * Where GitHub returns the browser after the operator approved the App.
 *
 * A GET that WRITES, which is unusual here and not a choice: GitHub decides
 * the shape of this redirect. The `code` it carries is single-use and
 * short-lived, so this is authenticated like any other write — a callback
 * URL is guessable, and without a session check anyone who could reach the
 * dashboard could bind an App of their own to a pending connection.
 */
export const Route = createFileRoute("/api/git-providers/github/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const installationId = url.searchParams.get("installation_id");

        if (!(state && UUID.test(state))) {
          return new Response("missing state", { status: 400 });
        }

        // GitHub returns to this SAME url twice: once with `code` after the
        // App is created, once with `installation_id` after it is installed.
        // Two steps on their side, one route on ours.
        if (installationId) {
          if (!NUMERIC.test(installationId)) {
            return new Response("invalid installation", { status: 400 });
          }
          await runGuarded({
            load: () =>
              db.query.githubProviders.findFirst({
                where: eq(githubProviders.gitProviderId, state),
              }),
            notFoundMessage: "unknown connection",
            permission: { action: "create", resource: "gitProvider" },
            run: async ({ row }) => {
              // One shot. Without this the route rebinds a working
              // connection to any installation id a crafted link carries —
              // and it is a GET, so a link is all it takes.
              if (!row.appId || row.installationId) {
                return;
              }
              await db
                .update(githubProviders)
                .set({ installationId })
                .where(eq(githubProviders.gitProviderId, state));
            },
            target: ({ row }) => ({ id: row.gitProviderId, name: "github" }),
          });
          return Response.redirect(new URL("/git-providers", request.url), 303);
        }

        if (!code) {
          return new Response("missing code", { status: 400 });
        }

        const provider = await db.query.gitProviders.findFirst({
          where: eq(gitProviders.id, state),
          with: { github: true },
        });
        if (!provider?.github) {
          return new Response("unknown connection", { status: 404 });
        }
        // Replaying a callback for a connection that is already set up would
        // overwrite a working App with credentials from a stale code.
        if (provider.github.appId) {
          return Response.redirect(new URL("/git-providers", request.url), 303);
        }

        try {
          await runGuarded({
            permission: { action: "create", resource: "gitProvider" },
            run: async () => {
              const created = await exchangeManifestCode(
                code,
                provider.github?.url ?? "https://github.com"
              );
              await saveCreatedApp(state, created);
            },
            target: () => ({ id: state, name: provider.name }),
          });
        } catch (err) {
          // The code is single-use: retrying this URL cannot work, so the
          // message has to send the operator back to the start rather than
          // read as a transient failure.
          const detail = err instanceof Error ? err.message : String(err);
          await db.delete(gitProviders).where(eq(gitProviders.id, state));
          return new Response(
            `Could not finish creating the GitHub App, and the code cannot be reused. Start the connection again.\n\n${detail}`,
            { headers: { "content-type": "text/plain" }, status: 400 }
          );
        }

        // Straight on to installing it: an App that exists but is installed
        // nowhere can list no repository, and stopping here would look
        // finished while nothing works.
        const app = await db.query.githubProviders.findFirst({
          where: eq(githubProviders.gitProviderId, state),
        });
        // The install page returns here with `installation_id`, handled at
        // the top of this same handler.
        return Response.redirect(
          app?.htmlUrl
            ? `${app.htmlUrl}/installations/new`
            : new URL("/git-providers", request.url).toString(),
          303
        );
      },
    },
  },
});
