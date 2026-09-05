import { githubProviders, gitProviders } from "@noddle/db/schema";
import { exchangeManifestCode } from "@noddle/git-provider/github";
import { createFileRoute } from "@tanstack/react-router";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db.server";
import { saveCreatedApp } from "@/lib/git-provider.server";
import { runGuarded } from "@/lib/permission.server";

const UUID = /^[0-9a-f-]{36}$/i;
const NUMERIC = /^[0-9]{1,20}$/;

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
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          const pending = await db.query.githubProviders.findFirst({
            where: eq(githubProviders.gitProviderId, state),
          });
          if (pending && !pending.appId) {
            await db.delete(gitProviders).where(eq(gitProviders.id, state));
          }
          return new Response(
            `Could not finish creating the GitHub App, and the code cannot be reused. Start the connection again.\n\n${detail}`,
            { headers: { "content-type": "text/plain" }, status: 400 }
          );
        }

        const app = await db.query.githubProviders.findFirst({
          where: eq(githubProviders.gitProviderId, state),
        });
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
