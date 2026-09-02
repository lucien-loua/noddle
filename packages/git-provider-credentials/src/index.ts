import { decryptSecret, encryptSecret, secretContext } from "@noddle/crypto";
import type { Database } from "@noddle/db";
import { gitlabProviders } from "@noddle/db/schema";
import {
  listBranches as githubBranches,
  cloneUrlWithToken as githubCloneUrl,
  listRepositories as githubRepositories,
  installationToken,
} from "@noddle/git-provider/github";
import type { GithubApp } from "@noddle/git-provider/github";
import {
  listBranches as gitlabBranches,
  cloneUrlWithToken as gitlabCloneUrl,
  listProjects,
  needsRefresh,
  refreshTokens,
} from "@noddle/git-provider/gitlab";
import type { GitlabApp } from "@noddle/git-provider/gitlab";
import { eq } from "drizzle-orm";

export interface GithubProviderRow {
  appId: string | null;
  installationId: string | null;
  privateKeyEncrypted: string | null;
  url: string;
}

export function githubAppFromRow(
  appKey: Buffer,
  gitProviderId: string,
  row: GithubProviderRow | null | undefined
): { appId: string; privateKeyPem: string; url: string } {
  if (!(row?.appId && row.privateKeyEncrypted)) {
    throw new Error("the GitHub App was never created");
  }
  return {
    appId: row.appId,
    privateKeyPem: decryptSecret(
      row.privateKeyEncrypted,
      appKey,
      secretContext.gitProvider(gitProviderId, "private_key")
    ),
    url: row.url,
  };
}

export function githubAppWithInstallation(
  appKey: Buffer,
  gitProviderId: string,
  name: string,
  row: GithubProviderRow | null | undefined
): GithubApp {
  if (!(row?.appId && row.privateKeyEncrypted)) {
    throw new Error(`${name}: the GitHub App was never created`);
  }
  if (!row.installationId) {
    throw new Error(
      `${name}: the App exists but is not installed on any account yet`
    );
  }
  return {
    ...githubAppFromRow(appKey, gitProviderId, row),
    installationId: row.installationId,
  };
}

export interface GitlabProviderRow {
  accessTokenEncrypted: string | null;
  applicationId: string | null;
  expiresAt: Date | null;
  redirectUri: string | null;
  refreshTokenEncrypted: string | null;
  secretEncrypted: string | null;
  url: string;
}

export function gitlabAppFromRow(
  appKey: Buffer,
  gitProviderId: string,
  name: string,
  row: GitlabProviderRow | null | undefined
): GitlabApp {
  if (!(row?.applicationId && row.secretEncrypted && row.redirectUri)) {
    throw new Error(`${name}: the GitLab application is not set up`);
  }
  return {
    applicationId: row.applicationId,
    redirectUri: row.redirectUri,
    secret: decryptSecret(
      row.secretEncrypted,
      appKey,
      secretContext.gitProvider(gitProviderId, "client_secret")
    ),
    url: row.url,
  };
}

export async function saveGitlabTokens(
  db: Database,
  appKey: Buffer,
  gitProviderId: string,
  tokens: { accessToken: string; expiresAt: number; refreshToken: string }
): Promise<void> {
  await db
    .update(gitlabProviders)
    .set({
      accessTokenEncrypted: encryptSecret(
        tokens.accessToken,
        appKey,
        secretContext.gitProvider(gitProviderId, "access_token")
      ),
      expiresAt: new Date(tokens.expiresAt),
      refreshTokenEncrypted: encryptSecret(
        tokens.refreshToken,
        appKey,
        secretContext.gitProvider(gitProviderId, "refresh_token")
      ),
    })
    .where(eq(gitlabProviders.gitProviderId, gitProviderId));
}

async function loadProvider(db: Database, gitProviderId: string) {
  const provider = await db.query.gitProviders.findFirst({
    where: (t, { eq: is }) => is(t.id, gitProviderId),
    with: { github: true, gitlab: true },
  });
  if (!provider) {
    throw new Error("git provider not found");
  }
  return provider;
}

export async function githubAppCredentials(
  db: Database,
  appKey: Buffer,
  gitProviderId: string
): Promise<{ appId: string; privateKeyPem: string; url: string }> {
  const provider = await loadProvider(db, gitProviderId);
  return githubAppFromRow(appKey, gitProviderId, provider.github);
}

export async function githubAppFor(
  db: Database,
  appKey: Buffer,
  gitProviderId: string
): Promise<GithubApp> {
  const provider = await loadProvider(db, gitProviderId);
  if (provider.providerType !== "github") {
    throw new Error(`${provider.name} is not a GitHub connection`);
  }
  return githubAppWithInstallation(
    appKey,
    gitProviderId,
    provider.name,
    provider.github
  );
}

export async function gitlabAppFor(
  db: Database,
  appKey: Buffer,
  gitProviderId: string
): Promise<{ app: GitlabApp; row: GitlabProviderRow }> {
  const provider = await loadProvider(db, gitProviderId);
  if (provider.providerType !== "gitlab") {
    throw new Error(`${provider.name} is not a GitLab connection`);
  }
  const app = gitlabAppFromRow(
    appKey,
    gitProviderId,
    provider.name,
    provider.gitlab
  );
  return { app, row: provider.gitlab as GitlabProviderRow };
}

export async function gitlabAccessToken(
  db: Database,
  appKey: Buffer,
  gitProviderId: string
): Promise<{ token: string; url: string }> {
  const { app, row } = await gitlabAppFor(db, appKey, gitProviderId);

  if (!needsRefresh(row.expiresAt?.getTime() ?? null)) {
    if (!row.accessTokenEncrypted) {
      throw new Error("this GitLab connection has no access token yet");
    }
    return {
      token: decryptSecret(
        row.accessTokenEncrypted,
        appKey,
        secretContext.gitProvider(gitProviderId, "access_token")
      ),
      url: app.url,
    };
  }

  if (!row.refreshTokenEncrypted) {
    throw new Error(
      "this GitLab connection was never authorised: connect it again"
    );
  }

  const refreshed = await refreshTokens(
    app,
    decryptSecret(
      row.refreshTokenEncrypted,
      appKey,
      secretContext.gitProvider(gitProviderId, "refresh_token")
    )
  );
  await saveGitlabTokens(db, appKey, gitProviderId, refreshed);
  return { token: refreshed.accessToken, url: app.url };
}

export async function gitlabWebhookSecret(
  db: Database,
  appKey: Buffer,
  gitProviderId: string
): Promise<string> {
  const provider = await loadProvider(db, gitProviderId);
  const encrypted = provider.gitlab?.webhookSecretEncrypted;
  if (!encrypted) {
    throw new Error(
      `${provider.name} has no webhook secret: reconnect it to arm autodeploy`
    );
  }
  return decryptSecret(
    encrypted,
    appKey,
    secretContext.gitProvider(gitProviderId, "webhook_secret")
  );
}

export interface ProviderRepo {
  defaultBranch: string;
  fullName: string;
  url: string;
}

export interface GitProviderAdapter {
  branches: (repositoryFullName: string) => Promise<string[]>;
  cloneUrl: (repoUrl: string) => Promise<string>;
  repositories: () => Promise<ProviderRepo[]>;
}

export async function providerFor(
  db: Database,
  appKey: Buffer,
  gitProviderId: string
): Promise<GitProviderAdapter> {
  const provider = await loadProvider(db, gitProviderId);

  if (provider.providerType === "gitlab") {
    const credentials = () => gitlabAccessToken(db, appKey, gitProviderId);
    return {
      branches: async (fullName) => {
        const { token, url } = await credentials();
        return await gitlabBranches(url, token, fullName);
      },
      cloneUrl: async (repoUrl) => {
        const { token } = await credentials();
        return gitlabCloneUrl(repoUrl, token);
      },
      repositories: async () => {
        const { token, url } = await credentials();
        return await listProjects(url, token);
      },
    };
  }

  const app = () =>
    Promise.resolve(
      githubAppWithInstallation(
        appKey,
        gitProviderId,
        provider.name,
        provider.github
      )
    );
  return {
    branches: async (fullName) => await githubBranches(await app(), fullName),
    cloneUrl: async (repoUrl) => {
      const { token } = await installationToken(await app());
      return githubCloneUrl(repoUrl, token);
    },
    repositories: async () =>
      (await githubRepositories(await app())).map((r) => ({
        defaultBranch: r.defaultBranch,
        fullName: r.fullName,
        url: r.url,
      })),
  };
}

export function isConnected(row: {
  github?: { appId: string | null; installationId: string | null } | null;
  gitlab?: { accessTokenEncrypted: string | null } | null;
  providerType: "github" | "gitlab";
}): boolean {
  return row.providerType === "gitlab"
    ? Boolean(row.gitlab?.accessTokenEncrypted)
    : Boolean(row.github?.appId && row.github.installationId);
}
