import { randomBytes } from "node:crypto";
import { encryptSecret, secretContext } from "@noddle/crypto";
import {
  githubProviders,
  gitlabProviders,
  gitProviders,
  services,
} from "@noddle/db/schema";
import {
  appManifest,
  installUrl,
  isPubliclyReachable,
  listBranches,
  listInstallations,
  listRepositories,
} from "@noddle/git-provider/github";
import {
  authorizeUrl,
  listBranches as gitlabBranches,
  listProjects,
} from "@noddle/git-provider/gitlab";
import { createServerFn } from "@tanstack/react-start";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db.server";
import { env } from "@/lib/env.server";
import { githubAppCredentials, githubAppFor } from "@/lib/git-provider.server";
import { gitlabAccessToken } from "@/lib/gitlab.server";
import { runGuarded, runRead } from "@/lib/permission.server";
import { requestOrigin } from "@/lib/request-origin.server";

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
          with: { github: true, gitlab: true },
        });
        const connected = await db.query.services.findMany({
          columns: { gitProviderId: true },
        });

        return rows.map((row) => ({
          // Each type answers "connected" its own way: GitHub needs an App
          // AND an installation, GitLab needs a token it was actually
          // given. Reading only the GitHub half left every GitLab
          // connection permanently "Not installed".
          connected:
            row.providerType === "gitlab"
              ? Boolean(row.gitlab?.accessTokenEncrypted)
              : Boolean(row.github?.appId && row.github.installationId),
          createdAt: row.createdAt.toISOString(),
          id: row.id,
          // Only offered once the App exists: before that there is nothing
          // to install, and the link would 404 on GitHub.
          // GitHub only: a GitLab application is authorised in one step,
          // so there is nothing left to install.
          installUrl:
            row.providerType === "github" &&
            row.github?.appId &&
            !row.github.installationId
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
          const origin = requestOrigin();

          // Refused HERE, and BEFORE the insert. GitHub requires a hook it
          // can reach and rejects the whole manifest otherwise, so failing
          // late would both send the browser away for nothing and leave a
          // pending row behind on every attempt.
          if (!isPubliclyReachable(origin)) {
            throw new Error(
              `GitHub must be able to reach this dashboard to deliver webhooks, and ${origin} is not reachable from the internet. Open Noddle on a public address — a tunnel URL works — and connect from there.`
            );
          }

          const id = crypto.randomUUID();
          await db.insert(gitProviders).values({
            id,
            name: data.name,
            providerType: "github",
          });
          await db
            .insert(githubProviders)
            .values({ gitProviderId: id, url: data.url });

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

const startGitlabSchema = z.object({
  applicationId: z.string().min(1).max(255),
  name: z.string().min(1).max(64),
  secret: z.string().min(1).max(512),
  /** `https://gitlab.com`, or a self-hosted instance. */
  url: z.url().max(255).default("https://gitlab.com"),
});

/**
 * Store the application and hand back where to send the browser.
 *
 * Unlike GitHub there is no manifest: the operator creates the application
 * on GitLab first and pastes its id and secret here. So the redirect URI is
 * shown to them BEFORE this — it has to match what they registered, and a
 * mismatch is refused by GitLab after the browser has already left.
 */
export const startGitlabApp = createServerFn({ method: "POST" })
  .validator(startGitlabSchema)
  .handler(async ({ data }): Promise<{ authorizeUrl: string }> => {
    const guarded = await runGuarded({
      permission: { action: "create", resource: "gitProvider" },
      run: async () => {
        const origin = requestOrigin();
        const redirectUri = `${origin}/api/git-providers/gitlab/callback`;
        const id = crypto.randomUUID();

        await db.insert(gitProviders).values({
          id,
          name: data.name,
          providerType: "gitlab",
        });
        // Minted here so "the secret exists" is an invariant of a connection
        // rather than a state it may or may not have reached. GitLab returns
        // it in `x-gitlab-token` on every delivery.
        const webhookSecret = randomBytes(32).toString("hex");

        await db.insert(gitlabProviders).values({
          applicationId: data.applicationId,
          gitProviderId: id,
          redirectUri,
          secretEncrypted: encryptSecret(
            data.secret,
            env.appKey,
            secretContext.gitProvider(id, "client_secret")
          ),
          url: data.url.replace(TRAILING_SLASHES, ""),
          webhookSecretEncrypted: encryptSecret(
            webhookSecret,
            env.appKey,
            secretContext.gitProvider(id, "webhook_secret")
          ),
        });

        return {
          authorizeUrl: authorizeUrl(
            {
              applicationId: data.applicationId,
              redirectUri,
              secret: data.secret,
              url: data.url,
            },
            id
          ),
          id,
          name: data.name,
        };
      },
      target: ({ result }) => ({ id: result.id, name: result.name }),
    });

    return { authorizeUrl: guarded.authorizeUrl };
  });

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

const syncInstallationSchema = z.object({ gitProviderId: z.uuid() });

/**
 * Ask the App which installations it has, and record the one it finds.
 *
 * The post-install redirect is not guaranteed to arrive — an App created
 * before `setup_url` existed never gets one, and a user who closes the tab
 * never sends one either. The App knows its own installations, so this
 * recovers the fact without recreating anything.
 */
export const syncGithubInstallation = createServerFn({ method: "POST" })
  .validator(syncInstallationSchema)
  .handler(
    async ({ data }): Promise<{ account: string } | { pending: true }> =>
      runGuarded({
        permission: { action: "create", resource: "gitProvider" },
        run: async () => {
          const app = await githubAppCredentials(data.gitProviderId);
          const installations = await listInstallations(app);
          const [found] = installations;
          if (!found) {
            return { pending: true as const };
          }
          if (installations.length > 1) {
            // One connection points at one installation. Picking silently
            // would bind repositories the operator did not choose.
            throw new Error(
              `this App is installed on ${installations.length} accounts (${installations
                .map((i) => i.account)
                .join(", ")}) — connect one App per account`
            );
          }
          await db
            .update(githubProviders)
            .set({ installationId: found.id })
            .where(eq(githubProviders.gitProviderId, data.gitProviderId));
          return { account: found.account };
        },
        target: () => ({ id: data.gitProviderId, name: "github" }),
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
          const provider = await db.query.gitProviders.findFirst({
            where: eq(gitProviders.id, data.gitProviderId),
          });
          if (provider?.providerType === "gitlab") {
            const { token, url } = await gitlabAccessToken(data.gitProviderId);
            const projects = await listProjects(url, token);
            return projects.map((r) => ({
              defaultBranch: r.defaultBranch,
              fullName: r.fullName,
              url: r.url,
            }));
          }
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
          const provider = await db.query.gitProviders.findFirst({
            where: eq(gitProviders.id, data.gitProviderId),
          });
          if (provider?.providerType === "gitlab") {
            const { token, url } = await gitlabAccessToken(data.gitProviderId);
            return await gitlabBranches(url, token, data.fullName);
          }
          const app = await githubAppFor(data.gitProviderId);
          return await listBranches(app, data.fullName);
        },
      })
  );
