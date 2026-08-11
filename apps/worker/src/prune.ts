import { deployments } from "@noddle/db/schema";
import {
  type DockerApi,
  disconnect,
  dockerClient,
  execArgv,
  type SshClient,
} from "@noddle/ssh-executor";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { recordDiskUsage } from "#metrics";
import { isPortableImage } from "#registry";
import { connectTo, type DeployContext } from "#runtime-context";

/**
 * A Noddle node's two build caches, and both are genuinely needed.
 *
 * `noddle-builder` is the capped builder (docker-container driver): it's the
 * one that builds applications. Its cache lives in the
 * `buildx_buildkit_noddle-builder0_state` volume, so **`docker system df`
 * counts it under "Volumes", not "Build Cache"** — measured on the VM:
 * `system df` reports 3.134GB of build cache, exactly what
 * `buildx du --builder default` returns, and not a single byte of the
 * capped builder's 1.663GB. A lone `docker builder prune` would therefore
 * never touch it.
 *
 * `default` is the daemon's built-in buildkit. Noddle builds no applications
 * there — but `install.sh` builds the CONTROL PLANE's images there
 * (`docker compose build`), once per update. Measured: 3.1GB.
 */
const BUILDERS = ["default", "noddle-builder"] as const;

/**
 * The age past which a build cache entry is considered dead.
 *
 * A filter and not a bare purge, because this cache is what keeps a second
 * build of an application fast. Measured on the VM: `until=1h` reclaims only
 * 12.6MB out of 1.66GB "reclaimable" — most of the cache is shared across all
 * builds and gets reused constantly. Clearing it every day would pay for a
 * slow daily build for almost nothing; letting it age for seven days
 * reclaims what a deleted project left behind and keeps what's actually used
 * warm.
 */
const CACHE_MAX_AGE = "168h";

/** A node that has never built anything yet has no capped builder. */
const NO_BUILDER = /no builder/i;

export interface NodePruneResult {
  /** Bytes reclaimed, as reported by the API — never re-parsed from a
   *  formatted CLI output, whose unit is decimal and whose rounding is
   *  destructive. */
  bytesReclaimed: number;
  containersDeleted: number;
  imagesDeleted: number;
  serverId: string;
}

export interface PruneResult {
  nodes: NodePruneResult[];
  /** IDs of deployments whose local image has disappeared. */
  reconciled: string[];
  /**
   * `false` when a server didn't return its image list.
   *
   * In that case we mark NOTHING: a local image can live on any node, and
   * declaring dead an image we couldn't search everywhere for would be
   * exactly the zero-instead-of-a-gap mistake this project refuses elsewhere.
   */
  reconciledFully: boolean;
  /** Unreachable servers. Their disk usage wasn't recorded, and that's all. */
  skipped: string[];
}

/**
 * Clears one builder's build cache.
 *
 * Via the CLI and not dockerode's `pruneBuilder()`: the `/build/prune` API
 * only talks to the daemon's built-in buildkit, whereas the capped builder
 * is a CONTAINER with its own buildkitd. Only `docker buildx prune --builder`
 * reaches it.
 *
 * We don't re-parse the bytes it reports — it's a size formatted for the
 * human eye, and reading it back as a number would cost precision and the
 * unit (the conversion trap already documented). The usage recorded right
 * after the prune carries the truth.
 */
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

/**
 * What a prune removes from a node — and, just as deliberately, what it
 * never touches.
 *
 * ORDER matters: containers first, because an image stops being referenced
 * the moment its last container disappears. Pruning images first would leave
 * a lagging pass every time.
 *
 * **Images are pruned with `dangling=false`, i.e. the CLI's `-a`, and this is
 * measured, not chosen:** a Noddle node has NO dangling images — measured on
 * the VM, 50 images, all tagged — because every build produces a tag and
 * `buildx --load` doesn't leave orphans behind. A prune without `-a` would
 * therefore reclaim zero bytes there, i.e. protection that looks like it's
 * working: the worst kind of failure by this project's rules.
 *
 * What stays standing doesn't rely on our own judgment but on Docker's own
 * rule: an image referenced by a container is never deleted. This covers
 * running Swarm tasks AND the control plane's containers (Traefik, Postgres,
 * Redis, the registry, web, and worker), all of which are running.
 *
 * **NEVER volumes.** A database's named volume is attached to nothing as
 * soon as its service is stopped: `docker volume prune` would wipe user data
 * without a word. It's the only irreversible loss this machine can suffer,
 * and the reason the command isn't just "not called" but absent from this
 * file entirely.
 *
 * **Never networks** either: the overlay belongs to Swarm and reclaims no
 * bytes.
 */
async function pruneNode(
  client: SshClient,
  docker: DockerApi
): Promise<Omit<NodePruneResult, "serverId">> {
  const containers = await docker.pruneContainers();
  const images = await docker.pruneImages({
    filters: JSON.stringify({ dangling: { false: true } }),
  });
  for (const builder of BUILDERS) {
    // biome-ignore lint/performance/noAwaitInLoops: two builders, deliberately sequential
    await pruneBuildCache(client, builder);
  }
  return {
    bytesReclaimed:
      (containers.SpaceReclaimed ?? 0) + (images.SpaceReclaimed ?? 0),
    containersDeleted: containers.ContainersDeleted?.length ?? 0,
    imagesDeleted: images.ImagesDeleted?.length ?? 0,
  };
}

/** Image tags present on a node, as the API returns them. */
async function imageTagsOn(docker: DockerApi): Promise<string[]> {
  const list = await docker.listImages();
  return list.flatMap((image) => image.RepoTags ?? []);
}

/**
 * Marks `image_purged` on every deployment whose LOCAL image has disappeared.
 *
 * Two rules, and each hinges on the question "which node are we talking
 * about".
 *
 * **A registry image is never affected.** Its local copy is only a cache —
 * Swarm removes it anyway after a push (`removeLocal`) and removes it again
 * on the next deployment. Its existence is decided in the registry, and
 * `registry-sweep.ts` is the one that decides it. Marking it here just
 * because one node no longer has it would remove a rollback that's perfectly
 * possible.
 *
 * **A local image is searched for on ALL nodes, not just the one we just
 * pruned.** Nothing says it wasn't built elsewhere, and a deployment from
 * before the registry carries no `node_id`. Hence `surveyed`: if even one
 * server didn't respond, nothing at all is marked.
 */
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
    // The row STAYS: which commit ran when doesn't have to disappear just
    // because we reclaimed some disk. Only the fact "the image no longer
    // exists" is recorded, so that history stops offering a rollback it
    // already knows would fail.
    await ctx.db
      .update(deployments)
      .set({ imagePurged: true })
      .where(inArray(deployments.id, gone));
  }
  return gone;
}

/**
 * One prune pass: each node, then reconciliation.
 *
 * `pruneEnabled` (per server, `true` by default) removes a node from
 * PRUNING — never from MONITORING. It's still probed for reconciliation and
 * for its disk usage; only the destructive command is skipped.
 */
export async function pruneDocker(ctx: DeployContext): Promise<PruneResult> {
  const result: PruneResult = {
    nodes: [],
    reconciled: [],
    reconciledFully: false,
    skipped: [],
  };

  const all = await ctx.db.query.servers.findMany();
  const connected = all.filter((server) => server.status === "connected");
  const present = new Set<string>();
  let surveyed = 0;

  for (const server of connected) {
    let client: SshClient | undefined;
    try {
      // One machine at a time: two simultaneous prunes would open N SSH
      // sessions from a 2GB control plane for work that's bounded by each
      // target's disk anyway.
      // biome-ignore lint/performance/noAwaitInLoops: deliberately sequential
      client = await connectTo(ctx, server);
      const docker = dockerClient(client);

      // `pruneEnabled=false` removes the DESTRUCTIVE half, not the
      // observing half. The node stays PROBED — its image list still feeds
      // reconciliation, and its disk is still recorded — otherwise
      // "spared" would become "invisible", and `reconciledFully` would
      // claim a certainty we no longer have about that particular node.
      if (server.pruneEnabled) {
        const counts = await pruneNode(client, docker);
        result.nodes.push({ ...counts, serverId: server.id });
      }

      // AFTER the prune, in this order: it's the after-state that says what
      // remains, and the after-usage that the machine's screen must show.
      // Recording before would show a full disk on a machine we just
      // emptied, for ten minutes.
      for (const tag of await imageTagsOn(docker)) {
        present.add(tag);
      }
      surveyed += 1;
      await recordDiskUsage(ctx, docker, server.id);
    } catch {
      // Unreachable, SSH refused, Docker down: nothing is pruned on this
      // machine, and above all nothing is KNOWN about what it contains.
      result.skipped.push(server.id);
    } finally {
      if (client) {
        disconnect(client);
      }
    }
  }

  // `all` and not `connected`: an `unreachable` server may still hold the
  // image we're about to declare dead. Not counting it would amount to not
  // knowing that we don't know.
  result.reconciledFully = surveyed === all.length;
  if (result.reconciledFully) {
    result.reconciled = await reconcile(ctx, present);
  }
  return result;
}
