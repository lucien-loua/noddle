import { encryptSecret, secretContext } from "@noddle/crypto";
import { githubProviders } from "@noddle/db/schema";
import type { GithubApp } from "@noddle/git-provider/github";
import {
  githubAppCredentials as appCredentials,
  githubAppFor as appFor,
} from "@noddle/git-provider-credentials";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db.server";
import { env } from "@/lib/env.server";

/**
 * Web-side binding of the shared credential module: this process's `db` and
 * `appKey`, nothing else. Decrypt, AAD and the refusal wording live in
 * `@noddle/git-provider-credentials` so the worker cannot drift from them.
 */

/**
 * The App's own credentials, WITHOUT requiring an installation — the
 * installation is exactly what is missing when we go looking for it.
 */
export function githubAppCredentials(
  gitProviderId: string
): Promise<{ appId: string; privateKeyPem: string; url: string }> {
  return appCredentials(db, env.appKey, gitProviderId);
}

export function githubAppFor(gitProviderId: string): Promise<GithubApp> {
  return appFor(db, env.appKey, gitProviderId);
}

/** Persist what the manifest exchange returned. Called by the callback. */
export async function saveCreatedApp(
  gitProviderId: string,
  created: {
    appId: string;
    clientId: string;
    clientSecret: string;
    htmlUrl: string;
    name: string;
    pem: string;
    webhookSecret: string;
  }
): Promise<void> {
  await db
    .update(githubProviders)
    .set({
      appId: created.appId,
      appName: created.name,
      clientId: created.clientId,
      clientSecretEncrypted: encryptSecret(
        created.clientSecret,
        env.appKey,
        secretContext.gitProvider(gitProviderId, "client_secret")
      ),
      htmlUrl: created.htmlUrl,
      privateKeyEncrypted: encryptSecret(
        created.pem,
        env.appKey,
        secretContext.gitProvider(gitProviderId, "private_key")
      ),
      webhookSecretEncrypted: encryptSecret(
        created.webhookSecret,
        env.appKey,
        secretContext.gitProvider(gitProviderId, "webhook_secret")
      ),
    })
    .where(eq(githubProviders.gitProviderId, gitProviderId));
}
