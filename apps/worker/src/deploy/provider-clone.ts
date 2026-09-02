import { providerFor } from "@noddle/git-provider-credentials";

import type { DeployContext } from "#runtime-context";

interface ProviderService {
  gitProvider?: { id: string } | null;
  gitRepoUrl: string | null;
}

export async function providerCloneUrl(
  ctx: DeployContext,
  service: ProviderService
): Promise<string | null> {
  const provider = service.gitProvider;
  if (!(provider && service.gitRepoUrl)) {
    return null;
  }
  const adapter = await providerFor(ctx.db, ctx.appKey, provider.id);
  return await adapter.cloneUrl(service.gitRepoUrl);
}
