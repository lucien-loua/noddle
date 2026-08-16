import { decryptSecret, encryptSecret, secretContext } from "@noddle/crypto";
import type { Database } from "@noddle/db";
import { gitlabProviders } from "@noddle/db/schema";
import {
  type GithubApp,
  cloneUrlWithToken as githubCloneUrl,
  installationToken,
} from "@noddle/git-provider/github";
import {
  type GitlabApp,
  cloneUrlWithToken as gitlabCloneUrl,
  needsRefresh,
  refreshTokens,
} from "@noddle/git-provider/gitlab";
import { eq } from "drizzle-orm";

/**
 * Credential half of the Git provider connections, shared by web and worker
 * the same way {@link @noddle/ssh-credentials} is shared for the SSH key
 * library: decrypt, AAD and the GitLab refresh policy live here so the two
 * processes cannot drift on them.
 *
 * The forge-specific token MODELS stay apart, as ADR-0019 requires — a
 * GitHub installation token is minted per use and never stored, a GitLab
 * access token is stored and expires. That asymmetry is the platform's.
 * What is shared is the handling around it.
 */

// ─────────────────────────────────────────────────────────────────────────────
// GitHub
// ─────────────────────────────────────────────────────────────────────────────

export interface GithubProviderRow {
  appId: string | null;
  installationId: string | null;
  privateKeyEncrypted: string | null;
  url: string;
}

/** The App's own credentials, WITHOUT requiring an installation. */
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

/**
 * The installed App, ready to call the API with.
 *
 * The refusals stay distinct: "never created" and "created but not
 * installed" are different problems with different fixes, and collapsing
 * them sends the operator to the wrong screen.
 */
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

// ─────────────────────────────────────────────────────────────────────────────
// GitLab
// ─────────────────────────────────────────────────────────────────────────────

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

/** Persist a freshly issued pair. Both halves rotate, so both are written. */
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

// ─────────────────────────────────────────────────────────────────────────────
// Lookup
// ─────────────────────────────────────────────────────────────────────────────

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
  // Non-null: `gitlabAppFromRow` refuses a missing row before this.
  return { app, row: provider.gitlab as GitlabProviderRow };
}

/**
 * A usable GitLab access token, refreshed first if it is close to expiring.
 *
 * Refreshing BEFORE use rather than on a 401 is the whole point: a 401
 * lands in the middle of a deploy and reads as a broken build. Every caller
 * in both processes goes through here so none of them can forget — this
 * function existing once is the reason the package exists.
 */
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
      "this GitLab connection was never authorised — connect it again"
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

/**
 * The URL git clones with, carrying a freshly minted token.
 *
 * The returned string is a SECRET that looks like a URL (ADR-0019): it goes
 * straight into the clone command and nowhere else. Minted per call and
 * never stored — a cached GitHub installation token starts failing about an
 * hour in, which surfaces as a clone that "randomly" 403s.
 */
export async function providerCloneUrl(
  db: Database,
  appKey: Buffer,
  gitProviderId: string,
  repoUrl: string
): Promise<string> {
  const provider = await loadProvider(db, gitProviderId);

  if (provider.providerType === "gitlab") {
    const { token } = await gitlabAccessToken(db, appKey, gitProviderId);
    return gitlabCloneUrl(repoUrl, token);
  }

  const app = githubAppWithInstallation(
    appKey,
    gitProviderId,
    provider.name,
    provider.github
  );
  const { token } = await installationToken(app);
  return githubCloneUrl(repoUrl, token);
}
