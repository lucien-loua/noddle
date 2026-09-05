import {
  gitlabAppFor as appFor,
  saveGitlabTokens as saveTokens,
} from "@noddle/git-provider-credentials";
import type { GitlabProviderRow } from "@noddle/git-provider-credentials";
import type { GitlabApp } from "@noddle/git-provider/gitlab";

import { db } from "@/lib/db.server";
import { env } from "@/lib/env.server";

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
