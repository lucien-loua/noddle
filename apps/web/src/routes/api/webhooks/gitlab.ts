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
  repoSlug,
} from "@/lib/webhook.server";

/**
 * The GitLab counterpart of `/api/webhooks/github`.
 *
 * One endpoint for every service of a connection, selected by the payload's
 * repository. It differs in exactly one way that matters: GitLab
 * authenticates with a SHARED SECRET in a header rather than an HMAC over
 * the body, so the comparison is constant-time on the token itself and
 * there is no signature to recompute.
 */
export const Route = createFileRoute("/api/webhooks/gitlab")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const token = request.headers.get("x-gitlab-token");
        if (!token) {
          return new Response("unsigned", { status: 401 });
        }

        const rawBody = await request.text();
        const repository = repositoryOf(rawBody);
        if (!repository) {
          return Response.json({ ignored: "no repository in payload" });
        }

        const provider = await providerForToken(token);
        if (!provider) {
          return new Response("invalid token", { status: 401 });
        }

        const targets = await db.query.services.findMany({
          where: and(
            eq(services.gitProviderId, provider),
            isNotNull(services.gitRepoUrl)
          ),
        });
        const matching = targets.filter(
          (s) => repoSlug(s.gitRepoUrl) === repository
        );
        if (matching.length === 0) {
          return Response.json({ ignored: `no service for ${repository}` });
        }

        const mr = parseWebhookPullRequest(rawBody);
        if (mr) {
          if (mr.fromFork) {
            return Response.json({ ignored: "merge request from a fork" });
          }
          const outcomes = await Promise.all(
            matching.map((s) =>
              mr.closed
                ? destroyPreview({
                    parentServiceId: s.id,
                    prNumber: mr.number,
                  })
                : ensurePreview({
                    commitSha: mr.commitSha,
                    headBranch: mr.headBranch,
                    parentServiceId: s.id,
                    prNumber: mr.number,
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

/** GitLab names it `project.path_with_namespace`, not `repository`. */
function repositoryOf(rawBody: string): string | null {
  try {
    const body = JSON.parse(rawBody) as {
      project?: { path_with_namespace?: unknown };
      repository?: { name?: unknown };
    };
    const path = body.project?.path_with_namespace;
    return typeof path === "string" ? path.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** The connection whose webhook secret matches, or `null`. */
async function providerForToken(token: string): Promise<string | null> {
  const rows = await db.query.gitProviders.findMany({
    where: eq(gitProviders.providerType, "gitlab"),
    with: { gitlab: true },
  });

  for (const row of rows) {
    const encrypted = row.gitlab?.webhookSecretEncrypted;
    if (!encrypted) {
      continue;
    }
    const secret = decryptSecret(
      encrypted,
      env.appKey,
      secretContext.gitProvider(row.id, "webhook_secret")
    );
    if (safeEqual(secret, token)) {
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
