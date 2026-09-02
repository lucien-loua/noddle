import { deployments } from "@noddle/db/schema";
import { isPortableImage } from "@noddle/registry";
import { disconnect, execArgv } from "@noddle/ssh-executor";
import type { DockerApi, SshClient } from "@noddle/ssh-executor";
import { and, eq, inArray, isNotNull } from "drizzle-orm";

import { recordDiskUsage } from "#metrics";
import type { DeployContext } from "#runtime-context";

const BUILDERS = ["default", "noddle-builder"] as const;

const CACHE_MAX_AGE = "168h";

const NO_BUILDER = /no builder/i;

export interface NodePruneResult {
  bytesReclaimed: number;
  containersDeleted: number;
  imagesDeleted: number;
  serverId: string;
}

export interface PruneResult {
  nodes: NodePruneResult[];
  reconciled: string[];
  reconciledFully: boolean;
  skipped: { reason: string; serverId: string }[];
}

async function pruneBuildCache(
  client: SshClient,
  builder: string
): Promise<void> {
  const res = await execArgv(client, [
    "sudo",
    "docker",
    "buildx",
    "prune",
    "--builder",
    builder,
    "--filter",
    `until=${CACHE_MAX_AGE}`,
    "--force",
  ]);
  if (res.code === 0 || NO_BUILDER.test(res.stderr)) {
    return;
  }
  throw new Error(
    `could not prune the build cache of ${builder} (code ${res.code}): ${res.stderr.trim().split("\n").slice(-2).join(" ")}`
  );
}

async function pruneNode(
  client: SshClient,
  docker: DockerApi
): Promise<Omit<NodePruneResult, "serverId">> {
  const containers = await docker.pruneContainers();
  const containerBytes = containers.SpaceReclaimed ?? 0;
  const containersDeleted = containers.ContainersDeleted?.length ?? 0;

  const images = await docker.pruneImages({
    filters: JSON.stringify({ dangling: { false: true } }),
  });
  for (const builder of BUILDERS) {
    await pruneBuildCache(client, builder);
  }
  return {
    bytesReclaimed: containerBytes + (images.SpaceReclaimed ?? 0),
    containersDeleted,
    imagesDeleted: images.ImagesDeleted?.length ?? 0,
  };
}

async function imageTagsOn(docker: DockerApi): Promise<string[]> {
  const list = await docker.listImages();
  return list.flatMap((image) => image.RepoTags ?? []);
}

async function reconcile(
  ctx: DeployContext,
  present: Set<string>
): Promise<string[]> {
  const rows = await ctx.db.query.deployments.findMany({
    where: and(
      isNotNull(deployments.imageTag),
      eq(deployments.imagePurged, false)
    ),
  });

  const gone = rows
    .filter(
      (row) =>
        row.imageTag &&
        !isPortableImage(row.imageTag, ctx.registry) &&
        !present.has(row.imageTag)
    )
    .map((row) => row.id);

  if (gone.length > 0) {
    await ctx.db
      .update(deployments)
      .set({ imagePurged: true })
      .where(inArray(deployments.id, gone));
  }
  return gone;
}

export async function pruneDocker(ctx: DeployContext): Promise<PruneResult> {
  const result: PruneResult = {
    nodes: [],
    reconciled: [],
    reconciledFully: false,
    skipped: [],
  };

  const all = await ctx.db.query.servers.findMany();
  const connected = all.filter((server) => server.status === "connected");

  for (const server of all) {
    if (server.status !== "connected") {
      result.skipped.push({
        reason: `server is ${server.status}, not connected`,
        serverId: server.id,
      });
    }
  }
  const present = new Set<string>();
  let surveyed = 0;

  for (const server of connected) {
    let client: SshClient | undefined;
    try {
      client = await ctx.connectTo(server);
      const docker = ctx.createDockerApi(client);

      if (server.pruneEnabled) {
        const counts = await pruneNode(client, docker);
        result.nodes.push({ ...counts, serverId: server.id });
      }

      for (const tag of await imageTagsOn(docker)) {
        present.add(tag);
      }
      surveyed += 1;
      await recordDiskUsage(ctx, docker, server.id);
    } catch (error) {
      result.skipped.push({
        reason: error instanceof Error ? error.message : String(error),
        serverId: server.id,
      });
    } finally {
      if (client) {
        disconnect(client);
      }
    }
  }

  result.reconciledFully = surveyed === all.length;
  if (result.reconciledFully) {
    result.reconciled = await reconcile(ctx, present);
  }
  return result;
}
