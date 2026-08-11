import { deployments, servers } from "@noddle/db/schema";
import { disconnect } from "@noddle/ssh-executor";
import { desc, eq, inArray } from "drizzle-orm";
import {
  deleteManifest,
  garbageCollect,
  KEEP_PER_SERVICE,
  parseRegistryRef,
  type RegistryConfig,
} from "#registry";
import { connectTo, type DeployContext } from "#runtime-context";

/** The registry container's name in the control plane's Compose stack. */
const REGISTRY_CONTAINER = "noddle-registry-1";

export interface RegistrySweepResult {
  /** `true` if garbage-collect ran — so if any bytes could come back. */
  collected: boolean;
  /** Image tags removed from the registry. */
  purged: string[];
}

interface PurgeCandidate {
  /** Every history row that carries this tag. */
  deploymentIds: string[];
  imageTag: string;
}

/**
 * Which of a service's tags fall outside the retention window.
 *
 * Pure, so verifiable without a registry or a database — and this is where
 * the two rules that matter live:
 *
 *   - we count DISTINCT TAGS, not rows. A rollback creates a new history
 *     row with the SAME tag; counting rows would purge images that are
 *     still young.
 *   - the CURRENT deployment's image is never a candidate, even if it's
 *     outside the window. Which happens as soon as an old version is
 *     replayed: it becomes current again without becoming recent again.
 */
export function tagsToPurge(opts: {
  currentImageTag: string | null;
  registry: RegistryConfig;
  rows: { id: string; imagePurged: boolean; imageTag: string | null }[];
}): PurgeCandidate[] {
  const byTag = new Map<string, string[]>();
  for (const row of opts.rows) {
    if (!row.imageTag || row.imagePurged) {
      continue;
    }
    // Image from before the registry: it's not there, nothing to delete
    // there. It lives in its node's local store, and it's the user's own
    // `docker image prune` that concerns it, not us.
    if (!parseRegistryRef(row.imageTag, opts.registry)) {
      continue;
    }
    const ids = byTag.get(row.imageTag);
    if (ids) {
      ids.push(row.id);
    } else {
      byTag.set(row.imageTag, [row.id]);
    }
  }

  const candidates: PurgeCandidate[] = [];
  let rank = 0;
  for (const [imageTag, deploymentIds] of byTag) {
    rank += 1;
    if (rank > KEEP_PER_SERVICE && imageTag !== opts.currentImageTag) {
      candidates.push({ deploymentIds, imageTag });
    }
  }
  return candidates;
}

/** Removes overly old images from the registry, service by service. */
export async function sweepRegistry(
  ctx: DeployContext,
  opts: { containerName?: string } = {}
): Promise<RegistrySweepResult> {
  const result: RegistrySweepResult = { collected: false, purged: [] };
  const { registry } = ctx;
  if (!registry) {
    return result;
  }

  const all = await ctx.db.query.services.findMany();
  const candidates: PurgeCandidate[] = [];

  for (const service of all) {
    // biome-ignore lint/performance/noAwaitInLoops: one service at a time, deliberately
    const rows = await ctx.db.query.deployments.findMany({
      orderBy: desc(deployments.createdAt),
      where: eq(deployments.serviceId, service.id),
    });
    const current = rows.find((r) => r.id === service.currentDeploymentId);
    candidates.push(
      ...tagsToPurge({
        currentImageTag: current?.imageTag ?? null,
        registry,
        rows,
      })
    );
  }

  for (const { deploymentIds, imageTag } of candidates) {
    const ref = parseRegistryRef(imageTag, registry);
    if (!ref) {
      continue;
    }
    // biome-ignore lint/performance/noAwaitInLoops: one manifest at a time, deliberately
    const gone = await deleteManifest(registry, ref);
    if (!gone) {
      continue;
    }
    // The history row STAYS — which commit ran when doesn't have to
    // disappear just because we reclaimed some disk. Only the fact "the
    // image no longer exists" is recorded, so the dashboard stops offering
    // a rollback it knows is impossible.
    await ctx.db
      .update(deployments)
      .set({ imagePurged: true })
      .where(inArray(deployments.id, deploymentIds));
    result.purged.push(imageTag);
  }

  if (result.purged.length === 0) {
    return result;
  }

  // Deleting manifests reclaims NOTHING — measured: the tags disappear and
  // the volume doesn't move a byte. Without this step, retention would give
  // a clean dashboard and a disk that fills up anyway, i.e. exactly the
  // bug it's supposed to fix.
  const manager = await ctx.db.query.servers.findFirst({
    where: eq(servers.role, "manager"),
  });
  if (!manager) {
    return result;
  }
  const client = await connectTo(ctx, manager);
  try {
    await garbageCollect(client, opts.containerName ?? REGISTRY_CONTAINER);
    result.collected = true;
  } finally {
    disconnect(client);
  }
  return result;
}
