import { githubProviders, gitProviders, services } from "@noddle/db/schema";
import {
  appManifest,
  installUrl,
  listBranches,
  listRepositories,
} from "@noddle/git-provider/github";
import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db.server";
import { githubAppFor } from "@/lib/git-provider.server";
import { runGuarded, runRead } from "@/lib/permission.server";

export interface GitProviderView {
  /** False until the App is created AND installed. */
  connected: boolean;
  createdAt: string;
  id: string;
  /** Where to send the operator to finish an unfinished connection. */
  installUrl: string | null;
  name: string;
  providerType: "github" | "gitlab";
  /** How many services clone through it. */
  serviceCount: number;
}

export const getGitProviders = createServerFn({ method: "GET" }).handler(
  async (): Promise<GitProviderView[]> =>
    runRead({
      permission: { action: "read", resource: "gitProvider" },
      read: async () => {
        const rows = await db.query.gitProviders.findMany({
          orderBy: desc(gitProviders.createdAt),
          with: { github: true },
        });
        const connected = await db.query.services.findMany({
          columns: { gitProviderId: true },
        });

        return rows.map((row) => ({
          connected: Boolean(row.github?.appId && row.github.installationId),
          createdAt: row.createdAt.toISOString(),
          id: row.id,
          // Only offered once the App exists: before that there is nothing
          // to install, and the link would 404 on GitHub.
          installUrl:
            row.github?.appId && !row.github.installationId
              ? installUrl(row.github.htmlUrl ?? "")
              : null,
          name: row.name,
          providerType: row.providerType,
          serviceCount: connected.filter((s) => s.gitProviderId === row.id)
            .length,
        }));
      },
    })
);

const TRAILING_SLASHES = /\/+$/;

/**
 * The dashboard's own origin, taken from the request rather than from a new
 * setting: GitHub has to reach both the callback and the webhook, and the
 * host the operator is currently using is the only one we know works.
 */
function requestOrigin(): string {
  const headers = getRequestHeaders();
  const host = headers.get("x-forwarded-host") ?? headers.get("host");
  if (!host) {
    throw new Error("cannot determine this dashboard's public URL");
  }
  const proto = headers.get("x-forwarded-proto") ?? "https";
  return `${proto}://${host}`;
}

const startGithubSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(34)
    // GitHub App names are global and constrained; a rejected name must not
    // be discovered after the browser has already left for GitHub.
    .regex(
      /^[a-zA-Z0-9][a-zA-Z0-9-]*$/,
      "letters, digits and dashes; cannot start with a dash"
    ),
  /** `https://github.com` or a GitHub Enterprise host. */
  url: z.url().max(255).default("https://github.com"),
});

/**
 * Reserve the row and hand back the manifest the BROWSER posts to GitHub.
 *
 * The row exists before the App does, on purpose: GitHub returns the
 * browser to a callback that has to know which connection it is finishing,
 * and the `state` it echoes back is the only thing carrying that.
 */
export const startGithubApp = createServerFn({ method: "POST" })
  .validator(startGithubSchema)
  .handler(
    async ({
      data,
    }): Promise<{ action: string; manifest: string; state: string }> => {
      const guarded = await runGuarded({
        permission: { action: "create", resource: "gitProvider" },
        run: async () => {
          const id = crypto.randomUUID();
          await db.insert(gitProviders).values({
            id,
            name: data.name,
            providerType: "github",
          });
          await db
            .insert(githubProviders)
            .values({ gitProviderId: id, url: data.url });

          const origin = requestOrigin();
          return {
            action: `${data.url.replace(TRAILING_SLASHES, "")}/settings/apps/new?state=${id}`,
            id,
            manifest: JSON.stringify(
              appManifest({
                name: data.name,
                redirectUrl: `${origin}/api/git-providers/github/callback`,
                url: origin,
                webhookUrl: `${origin}/api/webhooks/github`,
              })
            ),
            name: data.name,
          };
        },
        target: ({ result }) => ({ id: result.id, name: result.name }),
      });

      return {
        action: guarded.action,
        manifest: guarded.manifest,
        state: guarded.id,
      };
    }
  );

const deleteGitProviderSchema = z.object({ gitProviderId: z.uuid() });

/**
 * Disconnect a forge.
 *
 * The refusal is the point: `services.git_provider_id` is `set null`, so
 * Postgres would accept this silently and every service using it would
 * fall back to an unauthenticated clone at the next deploy — a failure
 * that surfaces far from its cause.
 */
export const deleteGitProvider = createServerFn({ method: "POST" })
  .validator(deleteGitProviderSchema)
  .handler(
    async ({ data }): Promise<{ ok: true }> =>
      runGuarded({
        load: () =>
          db.query.gitProviders.findFirst({
            where: eq(gitProviders.id, data.gitProviderId),
          }),
        notFoundMessage: "git provider not found",
        permission: { action: "delete", resource: "gitProvider" },
        run: async ({ row }) => {
          const used = await db.query.services.findMany({
            where: eq(services.gitProviderId, row.id),
          });
          if (used.length > 0) {
            throw new Error(
              `this connection still clones for ${used.length} service(s): ${used
                .map((s) => s.name)
                .join(", ")} — change their provider first`
            );
          }
          await db.delete(gitProviders).where(eq(gitProviders.id, row.id));
          return { ok: true as const };
        },
        target: ({ row }) => ({ id: row.id, name: row.name }),
      })
  );

const providerRepositoriesSchema = z.object({ gitProviderId: z.uuid() });

export const getProviderRepositories = createServerFn({ method: "GET" })
  .validator(providerRepositoriesSchema)
  .handler(
    async ({
      data,
    }): Promise<{ defaultBranch: string; fullName: string; url: string }[]> =>
      runRead({
        permission: { action: "read", resource: "gitProvider" },
        read: async () => {
          const app = await githubAppFor(data.gitProviderId);
          const repos = await listRepositories(app);
          return repos.map((r) => ({
            defaultBranch: r.defaultBranch,
            fullName: r.fullName,
            url: r.url,
          }));
        },
      })
  );

const providerBranchesSchema = z.object({
  fullName: z.string().min(1).max(255),
  gitProviderId: z.uuid(),
});

export const getProviderBranches = createServerFn({ method: "GET" })
  .validator(providerBranchesSchema)
  .handler(
    async ({ data }): Promise<string[]> =>
      runRead({
        permission: { action: "read", resource: "gitProvider" },
        read: async () => {
          const app = await githubAppFor(data.gitProviderId);
          return await listBranches(app, data.fullName);
        },
      })
  );
