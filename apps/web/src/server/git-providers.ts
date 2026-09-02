import { randomBytes } from "node:crypto";

import { encryptSecret, secretContext } from "@noddle/crypto";
import {
  githubProviders,
  gitlabProviders,
  gitProviders,
  services,
} from "@noddle/db/schema";
import { isConnected, providerFor } from "@noddle/git-provider-credentials";
import {
  appManifest,
  installUrl,
  isPubliclyReachable,
  listInstallations,
} from "@noddle/git-provider/github";
import { authorizeUrl } from "@noddle/git-provider/gitlab";
import { createServerFn } from "@tanstack/react-start";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db.server";
import { env } from "@/lib/env.server";
import { githubAppCredentials } from "@/lib/git-provider.server";
import { guarded, identityTarget } from "@/lib/guarded.server";
import { runGuarded, runRead } from "@/lib/permission.server";
import { requestOrigin } from "@/lib/request-origin.server";

export interface GitProviderView {
  connected: boolean;
  createdAt: string;
  id: string;
  installUrl: string | null;
  name: string;
  providerType: "github" | "gitlab";
  serviceCount: number;
}

export const getGitProviders = createServerFn({ method: "GET" }).handler(
  async (): Promise<GitProviderView[]> =>
    runRead({
      permission: { action: "read", resource: "gitProvider" },
      read: async () => {
        const [rows, connected] = await Promise.all([
          db.query.gitProviders.findMany({
            orderBy: desc(gitProviders.createdAt),
            with: { github: true, gitlab: true },
          }),
          db.query.services.findMany({ columns: { gitProviderId: true } }),
        ]);

        return rows.map((row) => ({
          connected: isConnected(row),
          createdAt: row.createdAt.toISOString(),
          id: row.id,
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
    .min(1, "Give this app a name.")
    .max(34, "Keep the name under 34 characters.")
    .regex(
      /^[a-zA-Z0-9][a-zA-Z0-9-]*$/,
      "letters, digits and dashes; cannot start with a dash"
    ),
  url: z
    .url("Enter a URL starting with https://.")
    .max(255, "Keep the URL under 255 characters.")
    .default("https://github.com"),
});

export const startGithubApp = createServerFn({ method: "POST" })
  .validator(startGithubSchema)
  .handler(
    async ({
      data,
    }): Promise<{ action: string; manifest: string; state: string }> => {
      const outcome = await runGuarded({
        permission: { action: "create", resource: "gitProvider" },
        run: async () => {
          const origin = requestOrigin();

          if (!isPubliclyReachable(origin)) {
            throw new Error(
              `GitHub must be able to reach this dashboard to deliver webhooks, and ${origin} is not reachable from the internet. Open Noddle on a public address (a tunnel URL works) and connect from there.`
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
                webhookUrl: `${origin}/api/webhooks/github/${id}`,
              })
            ),
            name: data.name,
          };
        },
        target: ({ result }) => ({ id: result.id, name: result.name }),
      });

      return {
        action: outcome.action,
        manifest: outcome.manifest,
        state: outcome.id,
      };
    }
  );

const startGitlabSchema = z.object({
  applicationId: z
    .string()
    .min(1, "Enter the application ID.")
    .max(255, "Keep the application ID under 255 characters."),
  name: z
    .string()
    .min(1, "Give this provider a name.")
    .max(64, "Keep the name under 64 characters."),
  secret: z
    .string()
    .min(1, "Enter the application secret.")
    .max(512, "Keep the secret under 512 characters."),
  url: z
    .url("Enter a URL starting with https://.")
    .max(255, "Keep the URL under 255 characters.")
    .default("https://gitlab.com"),
});

export const startGitlabApp = createServerFn({ method: "POST" })
  .validator(startGitlabSchema)
  .handler(async ({ data }): Promise<{ authorizeUrl: string }> => {
    const outcome = await runGuarded({
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

    return { authorizeUrl: outcome.authorizeUrl };
  });

const deleteGitProviderSchema = z.object({
  gitProviderId: z.uuid("Choose a Git provider."),
});

export const deleteGitProvider = createServerFn({ method: "POST" })
  .validator(deleteGitProviderSchema)
  .handler(async ({ data }): Promise<{ ok: true }> =>
    runGuarded({
      ...guarded.gitProvider(data.gitProviderId),
      permission: { action: "delete", resource: "gitProvider" },
      run: async ({ row }) => {
        const used = await db.query.services.findMany({
          where: eq(services.gitProviderId, row.id),
        });
        if (used.length > 0) {
          throw new Error(
            `this connection still clones for ${used.length} service(s): ${used
              .map((s) => s.name)
              .join(", ")}. Change their provider first`
          );
        }
        await db.delete(gitProviders).where(eq(gitProviders.id, row.id));
        return { ok: true as const };
      },
      target: identityTarget,
    })
  );

const syncInstallationSchema = z.object({
  gitProviderId: z.uuid("Choose a Git provider."),
});

export const syncGithubInstallation = createServerFn({ method: "POST" })
  .validator(syncInstallationSchema)
  .handler(async ({ data }): Promise<{ account: string } | { pending: true }> =>
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
          throw new Error(
            `this App is installed on ${installations.length} accounts (${installations
              .map((i) => i.account)
              .join(", ")}). Connect one App per account`
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

const providerRepositoriesSchema = z.object({
  gitProviderId: z.uuid("Choose a Git provider."),
});

export const getProviderRepositories = createServerFn({ method: "GET" })
  .validator(providerRepositoriesSchema)
  .handler(
    async ({
      data,
    }): Promise<{ defaultBranch: string; fullName: string; url: string }[]> =>
      runRead({
        permission: { action: "read", resource: "gitProvider" },
        read: async () => {
          const provider = await providerFor(
            db,
            env.appKey,
            data.gitProviderId
          );
          return await provider.repositories();
        },
      })
  );

const providerBranchesSchema = z.object({
  fullName: z
    .string()
    .min(1, "Choose a repository.")
    .max(255, "Keep the repository name under 255 characters."),
  gitProviderId: z.uuid("Choose a Git provider."),
});

export const getProviderBranches = createServerFn({ method: "GET" })
  .validator(providerBranchesSchema)
  .handler(async ({ data }): Promise<string[]> =>
    runRead({
      permission: { action: "read", resource: "gitProvider" },
      read: async () => {
        const provider = await providerFor(db, env.appKey, data.gitProviderId);
        return await provider.branches(data.fullName);
      },
    })
  );
