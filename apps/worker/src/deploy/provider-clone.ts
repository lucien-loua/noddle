import { decryptSecret, encryptSecret, secretContext } from "@noddle/crypto";
import { gitlabProviders } from "@noddle/db/schema";
import {
  cloneUrlWithToken,
  installationToken,
} from "@noddle/git-provider/github";
import {
  cloneUrlWithToken as gitlabCloneUrlWithToken,
  needsRefresh,
  refreshTokens,
} from "@noddle/git-provider/gitlab";
import { eq } from "drizzle-orm";
import type { DeployContext } from "#runtime-context";

/**
 * GitLab, where the token EXPIRES.
 *
 * Refreshed before the clone rather than on a failure: a token that dies
 * mid-build surfaces as a clone that "randomly" 403s, minutes in. The
 * renewed pair is persisted, because GitLab rotates the refresh token too.
 */
async function gitlabCloneUrl(
  ctx: DeployContext,
  provider: NonNullable<ProviderService["gitProvider"]>,
  repoUrl: string
): Promise<string> {
  const { gitlab } = provider;
  if (
    !(gitlab?.applicationId && gitlab.secretEncrypted && gitlab.redirectUri)
  ) {
    throw new Error(
      `provider ${provider.name} is not finished: authorise it on GitLab first`
    );
  }

  const app = {
    applicationId: gitlab.applicationId,
    redirectUri: gitlab.redirectUri,
    secret: decryptSecret(
      gitlab.secretEncrypted,
      ctx.appKey,
      secretContext.gitProvider(provider.id, "client_secret")
    ),
    url: gitlab.url,
  };

  if (!needsRefresh(gitlab.expiresAt?.getTime() ?? null)) {
    if (!gitlab.accessTokenEncrypted) {
      throw new Error(`provider ${provider.name} has no access token`);
    }
    return gitlabCloneUrlWithToken(
      repoUrl,
      decryptSecret(
        gitlab.accessTokenEncrypted,
        ctx.appKey,
        secretContext.gitProvider(provider.id, "access_token")
      )
    );
  }

  if (!gitlab.refreshTokenEncrypted) {
    throw new Error(
      `provider ${provider.name} was never authorised — connect it again`
    );
  }

  const tokens = await refreshTokens(
    app,
    decryptSecret(
      gitlab.refreshTokenEncrypted,
      ctx.appKey,
      secretContext.gitProvider(provider.id, "refresh_token")
    )
  );
  await ctx.db
    .update(gitlabProviders)
    .set({
      accessTokenEncrypted: encryptSecret(
        tokens.accessToken,
        ctx.appKey,
        secretContext.gitProvider(provider.id, "access_token")
      ),
      expiresAt: new Date(tokens.expiresAt),
      refreshTokenEncrypted: encryptSecret(
        tokens.refreshToken,
        ctx.appKey,
        secretContext.gitProvider(provider.id, "refresh_token")
      ),
    })
    .where(eq(gitlabProviders.gitProviderId, provider.id));

  return gitlabCloneUrlWithToken(repoUrl, tokens.accessToken);
}

interface ProviderService {
  gitProvider?: {
    github?: {
      appId: string | null;
      installationId: string | null;
      privateKeyEncrypted: string | null;
      url: string;
    } | null;
    gitlab?: {
      accessTokenEncrypted: string | null;
      applicationId: string | null;
      expiresAt: Date | null;
      redirectUri: string | null;
      refreshTokenEncrypted: string | null;
      secretEncrypted: string | null;
      url: string;
    } | null;
    id: string;
    name: string;
    providerType: "github" | "gitlab";
  } | null;
  gitRepoUrl: string | null;
}

/**
 * The clone URL for a service connected to a provider, carrying a freshly
 * minted token — or `null` when the service clones by URL.
 *
 * Minted per deploy and never stored. The installation token lives about an
 * hour; a cached one would start failing mid-build, which surfaces as a
 * clone that "randomly" 403s.
 *
 * The returned string is a SECRET (ADR-0019). It goes straight into the
 * clone command and nowhere else — the log sink redacts it if it ever
 * escapes, but that is the safety net, not the plan.
 */
export async function providerCloneUrl(
  ctx: DeployContext,
  service: ProviderService
): Promise<string | null> {
  const provider = service.gitProvider;
  if (!(provider && service.gitRepoUrl)) {
    return null;
  }

  if (provider.providerType === "gitlab") {
    return await gitlabCloneUrl(ctx, provider, service.gitRepoUrl);
  }

  const { github } = provider;
  if (!(github?.appId && github.installationId && github.privateKeyEncrypted)) {
    throw new Error(
      `provider ${provider.name} is not finished: create and install the GitHub App first`
    );
  }

  const { token } = await installationToken({
    appId: github.appId,
    installationId: github.installationId,
    privateKeyPem: decryptSecret(
      github.privateKeyEncrypted,
      ctx.appKey,
      secretContext.gitProvider(provider.id, "private_key")
    ),
    url: github.url,
  });

  return cloneUrlWithToken(service.gitRepoUrl, token);
}
