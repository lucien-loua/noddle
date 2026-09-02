import { encryptSecret, secretContext } from "@noddle/crypto";
import { githubProviders } from "@noddle/db/schema";
import { githubAppCredentials as appCredentials } from "@noddle/git-provider-credentials";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db.server";
import { env } from "@/lib/env.server";

export function githubAppCredentials(
  gitProviderId: string
): Promise<{ appId: string; privateKeyPem: string; url: string }> {
  return appCredentials(db, env.appKey, gitProviderId);
}

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
