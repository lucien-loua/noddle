import { decryptSecret, encryptSecret, secretContext } from "@noddle/crypto";
import { gitlabProviders, gitProviders } from "@noddle/db/schema";
import {
  type GitlabApp,
  needsRefresh,
  refreshTokens,
} from "@noddle/git-provider/gitlab";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db.server";
import { env } from "@/lib/env.server";

/** The application's own credentials, without a token. */
export async function gitlabAppFor(
  gitProviderId: string
): Promise<{ app: GitlabApp; row: typeof gitlabProviders.$inferSelect }> {
  const provider = await db.query.gitProviders.findFirst({
    where: eq(gitProviders.id, gitProviderId),
    with: { gitlab: true },
  });
  if (!provider) {
    throw new Error("git provider not found");
  }
  if (provider.providerType !== "gitlab") {
    throw new Error(`${provider.name} is not a GitLab connection`);
  }

  const { gitlab } = provider;
  if (
    !(gitlab?.applicationId && gitlab.secretEncrypted && gitlab.redirectUri)
  ) {
    throw new Error(`${provider.name}: the GitLab application is not set up`);
  }

  return {
    app: {
      applicationId: gitlab.applicationId,
      redirectUri: gitlab.redirectUri,
      secret: decryptSecret(
        gitlab.secretEncrypted,
        env.appKey,
        secretContext.gitProvider(gitProviderId, "client_secret")
      ),
      url: gitlab.url,
    },
    row: gitlab,
  };
}

/** Persist a freshly issued pair. Both halves rotate, so both are written. */
export async function saveGitlabTokens(
  gitProviderId: string,
  tokens: { accessToken: string; expiresAt: number; refreshToken: string }
): Promise<void> {
  await db
    .update(gitlabProviders)
    .set({
      accessTokenEncrypted: encryptSecret(
        tokens.accessToken,
        env.appKey,
        secretContext.gitProvider(gitProviderId, "access_token")
      ),
      expiresAt: new Date(tokens.expiresAt),
      refreshTokenEncrypted: encryptSecret(
        tokens.refreshToken,
        env.appKey,
        secretContext.gitProvider(gitProviderId, "refresh_token")
      ),
    })
    .where(eq(gitlabProviders.gitProviderId, gitProviderId));
}

/**
 * A usable access token, refreshed first if it is close to expiring.
 *
 * Refreshing BEFORE use rather than on a 401 is the whole point: a 401
 * lands in the middle of a deploy and reads as a broken build. Every
 * caller goes through here so none of them can forget.
 */
export async function gitlabAccessToken(
  gitProviderId: string
): Promise<{ token: string; url: string }> {
  const { app, row } = await gitlabAppFor(gitProviderId);

  if (!needsRefresh(row.expiresAt?.getTime() ?? null)) {
    if (!row.accessTokenEncrypted) {
      throw new Error("this GitLab connection has no access token yet");
    }
    return {
      token: decryptSecret(
        row.accessTokenEncrypted,
        env.appKey,
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
      env.appKey,
      secretContext.gitProvider(gitProviderId, "refresh_token")
    )
  );
  await saveGitlabTokens(gitProviderId, refreshed);
  return { token: refreshed.accessToken, url: app.url };
}
