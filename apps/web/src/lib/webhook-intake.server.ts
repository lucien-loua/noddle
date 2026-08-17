import { services } from "@noddle/db/schema";
import { shouldDeployPaths } from "@noddle/shared/watch-paths";
import { and, eq, isNotNull } from "drizzle-orm";

import { db } from "@/lib/db.server";
import { queueServiceDeploy } from "@/lib/deploy-queue.server";
import { destroyPreview, ensurePreview } from "@/lib/preview.server";
import { parseWebhookPullRequest, parseWebhookPush, repositoryMatches } from "@/lib/webhook.server";

/**
 * Everything between a signed payload arriving and Jobs being enqueued.
 *
 * Only ONE thing varies between the endpoints that receive webhooks: how a
 * delivery is turned into the Services it is for. A forge endpoint
 * authenticates a connection and matches the payload's repository; the
 * per-service endpoint is told by its URL. Everything after — previews, skip
 * rules, enqueueing, the response — was copied per endpoint and drifted.
 */

type TargetService = typeof services.$inferSelect;

export type Resolved =
  /** Authentication failed. The only case that is not a 200. */
  | { refused: { message: string; status: number } }
  /** Authentic, but there is nothing to act on. */
  | { ignored: string }
  | { services: TargetService[] };

export type ResolveTargets = (request: Request, rawBody: string) => Promise<Resolved>;

/**
 * Why this push does not deploy this service, or `null` to deploy.
 *
 * `autoDeploy` is checked before the branch: when autodeploy is off, that is
 * the setting the user can act on, and answering `branch feature/x` instead
 * sends them to look at the wrong one.
 */
function skipReason(
  service: {
    autoDeploy: boolean;
    gitBranch: string | null;
    watchPaths: string[];
  },
  push: { branch: string; files: string[] },
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

async function handlePullRequest(
  targets: TargetService[],
  rawBody: string,
): Promise<Response | null> {
  const pr = parseWebhookPullRequest(rawBody);
  if (!pr) {
    return null;
  }
  // A fork's pull request gets no preview: it would run outside code with
  // the parent's secrets.
  if (pr.fromFork) {
    return Response.json({ ignored: "pull request from a fork" });
  }
  const outcomes = await Promise.all(
    targets.map((s) =>
      pr.closed
        ? destroyPreview({ parentServiceId: s.id, prNumber: pr.number })
        : ensurePreview({
            commitSha: pr.commitSha,
            headBranch: pr.headBranch,
            parentServiceId: s.id,
            prNumber: pr.number,
          }),
    ),
  );
  return Response.json({ outcomes });
}

async function handlePush(targets: TargetService[], rawBody: string): Promise<Response> {
  const push = parseWebhookPush(rawBody);
  if (!push) {
    // 200, not 4xx: an event other than a branch push is not an error.
    return Response.json({ ignored: "unrecognized payload" });
  }

  const skipped: string[] = [];
  const toDeploy = targets.filter((service) => {
    const reason = skipReason(service, push);
    if (reason) {
      skipped.push(`${service.name}: ${reason}`);
    }
    return reason === null;
  });

  // Enqueueing is independent per service — the queue's concurrency of 1 is
  // what serialises the actual work, not this loop.
  const queued = await Promise.all(
    toDeploy.map((service) =>
      queueServiceDeploy(service.id, {
        commitSha: push.commitSha,
        trigger: "webhook",
      }).then((r) => r.deploymentId),
    ),
  );
  return Response.json({ queued, skipped });
}

export async function handleWebhook(request: Request, resolve: ResolveTargets): Promise<Response> {
  // The EXACT bytes: reparsing before verifying breaks every signature
  // comparison downstream of here.
  const rawBody = await request.text();
  const resolved = await resolve(request, rawBody);

  if ("refused" in resolved) {
    return new Response(resolved.refused.message, {
      status: resolved.refused.status,
    });
  }
  if ("ignored" in resolved) {
    return Response.json({ ignored: resolved.ignored });
  }
  if (resolved.services.length === 0) {
    return Response.json({ ignored: "no service for this delivery" });
  }

  // The same webhook carries both events. The payloads are disjoint — a push
  // has no `action`, a pull request no `ref` — so the read order is free.
  return (
    (await handlePullRequest(resolved.services, rawBody)) ??
    (await handlePush(resolved.services, rawBody))
  );
}

/**
 * A forge endpoint's targets: every Service of the connection that deploys
 * the repository the payload names.
 *
 * Several, on purpose — nothing stops two Services deploying one repository
 * on different branches.
 */
export async function servicesOfRepository(
  gitProviderId: string,
  repository: string,
): Promise<TargetService[]> {
  const targets = await db.query.services.findMany({
    where: and(eq(services.gitProviderId, gitProviderId), isNotNull(services.gitRepoUrl)),
  });
  return targets.filter((s) => repositoryMatches(s, repository));
}
