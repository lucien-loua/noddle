import { deployments, servers } from "@noddle/db/schema";
import type { RegistryConfig } from "@noddle/deploy-engine";
import {
  deleteManifest,
  garbageCollect,
  KEEP_PER_SERVICE,
  parseRegistryRef,
} from "@noddle/deploy-engine/ops";
import { disconnect } from "@noddle/ssh-executor";
import { desc, eq, inArray } from "drizzle-orm";

import type { DeployContext } from "#runtime-context";

const REGISTRY_CONTAINER = "noddle-registry-1";

export interface RegistrySweepResult {
  collected: boolean;
  purged: string[];
}

interface PurgeCandidate {
  deploymentIds: string[];
  imageTag: string;
}

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
    const gone = await deleteManifest(registry, ref);
    if (!gone) {
      continue;
    }
    await ctx.db
      .update(deployments)
      .set({ imagePurged: true })
      .where(inArray(deployments.id, deploymentIds));
    result.purged.push(imageTag);
  }

  if (result.purged.length === 0) {
    return result;
  }

  const manager = await ctx.db.query.servers.findFirst({
    where: eq(servers.role, "manager"),
  });
  if (!manager) {
    return result;
  }
  const client = await ctx.connectTo(manager);
  try {
    await garbageCollect(client, opts.containerName ?? REGISTRY_CONTAINER);
    result.collected = true;
  } finally {
    disconnect(client);
  }
  return result;
}
