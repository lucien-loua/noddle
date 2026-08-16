import { createHmac } from "node:crypto";
import { decryptSecret, safeEqual, secretContext } from "@noddle/crypto";
import { gitProviders } from "@noddle/db/schema";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db.server";
import { env } from "@/lib/env.server";
import { payloadRepository } from "@/lib/webhook.server";
import type { Resolved } from "@/lib/webhook-intake.server";
import { servicesOfRepository } from "@/lib/webhook-intake.server";

/**
 * The two forge adapters: authenticate a connection, then name the
 * repository. Everything after that is `handleWebhook`.
 *
 * Hooks Noddle registers carry the connection in their URL. Without one, the
 * connection is found by trying each candidate's secret — a handful of rows,
 * constant-time per candidate.
 */

type Forge = "github" | "gitlab";

function webhookSecretOf(row: {
  github?: { webhookSecretEncrypted: string | null } | null;
  gitlab?: { webhookSecretEncrypted: string | null } | null;
  id: string;
}): string | null {
  const encrypted =
    row.github?.webhookSecretEncrypted ?? row.gitlab?.webhookSecretEncrypted;
  return encrypted
    ? decryptSecret(
        encrypted,
        env.appKey,
        secretContext.gitProvider(row.id, "webhook_secret")
      )
    : null;
}

/** GitHub signs the body; GitLab echoes the shared secret in a header. */
function presents(
  forge: Forge,
  request: Request,
  rawBody: string,
  secret: string
): boolean {
  if (forge === "gitlab") {
    const token = request.headers.get("x-gitlab-token");
    return token !== null && safeEqual(secret, token);
  }
  const signature = request.headers.get("x-hub-signature-256");
  if (!signature) {
    return false;
  }
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  return safeEqual(expected, signature);
}

async function providerFor(
  forge: Forge,
  request: Request,
  rawBody: string,
  gitProviderId?: string
): Promise<string | null> {
  const rows = gitProviderId
    ? await db.query.gitProviders
        .findFirst({
          where: eq(gitProviders.id, gitProviderId),
          with: { github: true, gitlab: true },
        })
        .then((row) => (row ? [row] : []))
    : await db.query.gitProviders.findMany({
        where: eq(gitProviders.providerType, forge),
        with: { github: true, gitlab: true },
      });

  for (const row of rows) {
    if (row.providerType !== forge) {
      continue;
    }
    const secret = webhookSecretOf(row);
    if (secret && presents(forge, request, rawBody, secret)) {
      return row.id;
    }
  }
  return null;
}

export function forgeTargets(forge: Forge, gitProviderId?: string) {
  return async (request: Request, rawBody: string): Promise<Resolved> => {
    const provider = await providerFor(forge, request, rawBody, gitProviderId);
    if (!provider) {
      return {
        refused: {
          message: forge === "gitlab" ? "invalid token" : "invalid signature",
          status: 401,
        },
      };
    }

    const repository = payloadRepository(forge, rawBody);
    if (!repository) {
      return { ignored: "no repository in payload" };
    }
    return { services: await servicesOfRepository(provider, repository) };
  };
}
