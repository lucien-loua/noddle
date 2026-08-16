import type { GitlabApp } from "@noddle/git-provider/gitlab";
import {
  gitlabAccessToken as accessToken,
  gitlabAppFor as appFor,
  type GitlabProviderRow,
  saveGitlabTokens as saveTokens,
} from "@noddle/git-provider-credentials";
import { db } from "@/lib/db.server";
import { env } from "@/lib/env.server";

/**
 * Web-side binding of the shared credential module, twin of
 * `git-provider.server.ts`. The refresh-before-use policy itself lives in
 * `@noddle/git-provider-credentials`: it used to be written here AND in the
 * worker's clone path, which is exactly the drift the package prevents.
 */

export function gitlabAppFor(
  gitProviderId: string
): Promise<{ app: GitlabApp; row: GitlabProviderRow }> {
  return appFor(db, env.appKey, gitProviderId);
}

export function saveGitlabTokens(
  gitProviderId: string,
  tokens: { accessToken: string; expiresAt: number; refreshToken: string }
): Promise<void> {
  return saveTokens(db, env.appKey, gitProviderId, tokens);
}

export function gitlabAccessToken(
  gitProviderId: string
): Promise<{ token: string; url: string }> {
  return accessToken(db, env.appKey, gitProviderId);
}
