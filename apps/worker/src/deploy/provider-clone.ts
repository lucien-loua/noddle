import { providerCloneUrl as cloneUrlFor } from "@noddle/git-provider-credentials";
import type { DeployContext } from "#runtime-context";

interface ProviderService {
  gitProvider?: { id: string } | null;
  gitRepoUrl: string | null;
}

/**
 * The clone URL for a service connected to a provider, carrying a freshly
 * minted token — or `null` when the service clones by URL.
 *
 * The credential work happens in `@noddle/git-provider-credentials`, shared
 * with web. It used to be reimplemented here: the GitLab refresh-before-use
 * dance existed once in this file and once in `gitlab.server.ts`, in two
 * processes, and either could have drifted from the other without anything
 * failing until a token expired mid-build.
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
  return await cloneUrlFor(ctx.db, ctx.appKey, provider.id, service.gitRepoUrl);
}
