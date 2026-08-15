import { decryptSecret, encryptSecret, secretContext } from "@noddle/crypto";
import { githubProviders, gitProviders } from "@noddle/db/schema";
import type { GithubApp } from "@noddle/git-provider/github";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db.server";
import { env } from "@/lib/env.server";

/**
 * Load a connection and decrypt its App key.
 *
 * The refusals are deliberately distinct: "not a GitHub connection" and
 * "the App was never finished" are different problems with different fixes,
 * and collapsing them into one message sends the operator to the wrong
 * screen.
 */
export async function githubAppFor(gitProviderId: string): Promise<GithubApp> {
  const provider = await db.query.gitProviders.findFirst({
    where: eq(gitProviders.id, gitProviderId),
    with: { github: true },
  });
  if (!provider) {
    throw new Error("git provider not found");
  }
  if (provider.providerType !== "github") {
    throw new Error(`${provider.name} is not a GitHub connection`);
  }

  const { github } = provider;
  if (!(github?.appId && github.privateKeyEncrypted)) {
    throw new Error(`${provider.name}: the GitHub App was never created`);
  }
  if (!github.installationId) {
    throw new Error(
      `${provider.name}: the App exists but is not installed on any account yet`
    );
  }

  return {
    appId: github.appId,
    installationId: github.installationId,
    privateKeyPem: decryptSecret(
      github.privateKeyEncrypted,
      env.appKey,
      secretContext.gitProvider(gitProviderId, "private_key")
    ),
    url: github.url,
  };
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
