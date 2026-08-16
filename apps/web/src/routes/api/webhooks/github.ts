import { createHmac } from "node:crypto";
import { decryptSecret, safeEqual, secretContext } from "@noddle/crypto";
import { gitProviders, services } from "@noddle/db/schema";
import { shouldDeployPaths } from "@noddle/shared/watch-paths";
import { createFileRoute } from "@tanstack/react-router";
import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db.server";
import { queueServiceDeploy } from "@/lib/deploy-queue.server";
import { env } from "@/lib/env.server";
import { destroyPreview, ensurePreview } from "@/lib/preview.server";
import {
  parseWebhookPullRequest,
  parseWebhookPush,
  repositoryMatches,
} from "@/lib/webhook.server";

/**
 * The App's own webhook, declared in the manifest at creation.
 *
 * Different from `/api/webhooks/service/:id` in the one way that matters:
 * there, the URL identifies the service and the secret is the service's.
 * Here ONE endpoint serves every service of a connection, so the payload's
 * repository is what selects them — and it selects several, since nothing
 * stops two services deploying the same repository on different branches.
 */
export const Route = createFileRoute("/api/webhooks/github")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // The EXACT bytes: reparsing before verifying breaks the comparison.
        const rawBody = await request.text();
        const signature = request.headers.get("x-hub-signature-256");
        if (!signature) {
          return new Response("unsigned", { status: 401 });
        }

        const repository = repositoryOf(rawBody);
        if (!repository) {
          return Response.json({ ignored: "no repository in payload" });
        }

        // Which connection signed this is not in the payload, so every
        // configured App is tried. Comparison stays constant-time per
        // candidate; there are a handful of rows, not thousands.
        const provider = await providerForSignature(rawBody, signature);
        if (!provider) {
          return new Response("invalid signature", { status: 401 });
        }

        const targets = await db.query.services.findMany({
          where: and(
            eq(services.gitProviderId, provider),
            isNotNull(services.gitRepoUrl)
          ),
        });
        const matching = targets.filter((s) =>
          repositoryMatches(s, repository)
        );
        if (matching.length === 0) {
          return Response.json({ ignored: `no service for ${repository}` });
        }

        const pr = parseWebhookPullRequest(rawBody);
        if (pr) {
          // A fork's pull request gets no preview: it would run outside
          // code with the parent's secrets.
          if (pr.fromFork) {
            return Response.json({ ignored: "pull request from a fork" });
          }
          const outcomes = await Promise.all(
            matching.map((s) =>
              pr.closed
                ? destroyPreview({
                    parentServiceId: s.id,
                    prNumber: pr.number,
                  })
                : ensurePreview({
                    commitSha: pr.commitSha,
                    headBranch: pr.headBranch,
                    parentServiceId: s.id,
                    prNumber: pr.number,
                  })
            )
          );
          return Response.json({ outcomes });
        }

        const push = parseWebhookPush(rawBody);
        if (!push) {
          return Response.json({ ignored: "unrecognized payload" });
        }

        const skipped: string[] = [];
        const toDeploy = matching.filter((service) => {
          const reason = skipReason(service, push);
          if (reason) {
            skipped.push(`${service.name}: ${reason}`);
          }
          return reason === null;
        });

        // Enqueueing is independent per service — the queue's concurrency of
        // 1 is what serialises the actual work, not this loop.
        const queued = await Promise.all(
          toDeploy.map((service) =>
            queueServiceDeploy(service.id, {
              commitSha: push.commitSha,
              trigger: "webhook",
            }).then((r) => r.deploymentId)
          )
        );
        return Response.json({ queued, skipped });
      },
    },
  },
});

/** `owner/name`, the only stable identity shared by payload and clone URL. */
function repositoryOf(rawBody: string): string | null {
  try {
    const body = JSON.parse(rawBody) as {
      repository?: { full_name?: unknown };
    };
    const full = body.repository?.full_name;
    return typeof full === "string" ? full.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** The connection whose secret signs this body, or `null`. */
async function providerForSignature(
  rawBody: string,
  signature: string
): Promise<string | null> {
  const rows = await db.query.gitProviders.findMany({
    where: eq(gitProviders.providerType, "github"),
    with: { github: true },
  });

  for (const row of rows) {
    const encrypted = row.github?.webhookSecretEncrypted;
    if (!encrypted) {
      continue;
    }
    const secret = decryptSecret(
      encrypted,
      env.appKey,
      secretContext.gitProvider(row.id, "webhook_secret")
    );
    const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
    if (safeEqual(expected, signature)) {
      return row.id;
    }
  }
  return null;
}

/** Why this push does not deploy this service, or `null` to deploy. */
function skipReason(
  service: {
    autoDeploy: boolean;
    gitBranch: string | null;
    watchPaths: string[];
  },
  push: { branch: string; files: string[] }
): string | null {
  if (!service.autoDeploy) {
    return "autodeploy disabled";
  }
  if (!service.gitBranch || push.branch !== service.gitBranch) {
    return `branch ${push.branch}`;
  }
  if (!shouldDeployPaths(service.watchPaths, push.files)) {
    return "no watched path changed";
  }
  return null;
}
