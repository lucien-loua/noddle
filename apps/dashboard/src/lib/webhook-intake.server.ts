import { services } from "@noddle/db/schema";
import { shouldDeployPaths } from "@noddle/shared/watch-paths";
import { and, eq, isNotNull } from "drizzle-orm";

import { db } from "@/lib/db.server";
import { queueServiceDeploy } from "@/lib/deploy-queue.server";
import { destroyPreview, ensurePreview } from "@/lib/preview.server";
import {
  parseWebhookPullRequest,
  parseWebhookPush,
  repositoryMatches,
} from "@/lib/webhook.server";

type TargetService = typeof services.$inferSelect;

export type Resolved =
  | { refused: { message: string; status: number } }
  | { ignored: string }
  | { services: TargetService[] };

export type ResolveTargets = (
  request: Request,
  rawBody: string
) => Promise<Resolved>;

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

async function handlePullRequest(
  targets: TargetService[],
  rawBody: string
): Promise<Response | null> {
  const pr = parseWebhookPullRequest(rawBody);
  if (!pr) {
    return null;
  }
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
          })
    )
  );
  return Response.json({ outcomes });
}

async function handlePush(
  targets: TargetService[],
  rawBody: string
): Promise<Response> {
  const push = parseWebhookPush(rawBody);
  if (!push) {
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

  const queued = await Promise.all(
    toDeploy.map((service) =>
      queueServiceDeploy(service.id, {
        commitSha: push.commitSha,
        trigger: "webhook",
      }).then((r) => r.deploymentId)
    )
  );
  return Response.json({ queued, skipped });
}

export async function handleWebhook(
  request: Request,
  resolve: ResolveTargets
): Promise<Response> {
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

  return (
    (await handlePullRequest(resolved.services, rawBody)) ??
    (await handlePush(resolved.services, rawBody))
  );
}

export async function servicesOfRepository(
  gitProviderId: string,
  repository: string
): Promise<TargetService[]> {
  const targets = await db.query.services.findMany({
    where: and(
      eq(services.gitProviderId, gitProviderId),
      isNotNull(services.gitRepoUrl)
    ),
  });
  return targets.filter((s) => repositoryMatches(s, repository));
}
