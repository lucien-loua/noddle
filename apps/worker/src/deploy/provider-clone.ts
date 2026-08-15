import { decryptSecret, secretContext } from "@noddle/crypto";
import {
  cloneUrlWithToken,
  installationToken,
} from "@noddle/git-provider/github";
import type { DeployContext } from "#runtime-context";

interface ProviderService {
  gitProvider?: {
    github?: {
      appId: string | null;
      installationId: string | null;
      privateKeyEncrypted: string | null;
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

  if (provider.providerType !== "github") {
    // GitLab is sequenced after GitHub (ADR-0019). Failing loudly beats
    // silently falling back to an anonymous clone, which would look like a
    // permissions problem on a private repository.
    throw new Error(`provider ${provider.providerType} is not wired yet`);
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
