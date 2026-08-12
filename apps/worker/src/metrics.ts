import {
  databases,
  serverDiskUsage,
  serverMetrics,
  servers,
  serviceMetrics,
  services,
} from "@noddle/db/schema";
import { swarmServiceName } from "@noddle/shared/swarm-names";
import { type DockerApi, disconnect, exec } from "@noddle/ssh-executor";
import { desc, eq, lt } from "drizzle-orm";
import type { DeployContext } from "#runtime-context";

/** Seven days. Beyond that, aggregation would be needed, so a time-series basis. */
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The disk usage cadence, TEN times slower than the rest.
 *
 * Measured, not chosen: `/system/df` asks the daemon to walk its layer
 * store — 0.65s of work and a 131KB response on a 2GB VM, to extract twelve
 * integers from it. At a per-minute cadence, that would be 188MB per day and
 * per machine through the SSH tunnel. And there's nothing to catch up on any
 * faster: disk changes with a deployment or a retention pass, not by the
 * second.
 */
const DISK_USAGE_INTERVAL_MS = 10 * 60 * 1000;

const KIB = 1024;
const WHITESPACE = /\s+/;
const LEADING_SLASH = /^\//;

/**
 * The machine's facts, in one command and without a fragile pipe.
 *
 * `awk` reads the files directly rather than receiving a pipe: these scripts
 * run under `set -o pipefail`, where a consumer that exits early sends a
 * SIGPIPE to the producer. `tail -n1` is safe — it reads to the end —
 * unlike `head` or `grep -q`.
 */
const HOST_FACTS = [
  "LOAD=$(awk '{print $1}' /proc/loadavg)",
  "CORES=$(nproc)",
  "MT=$(awk '/^MemTotal:/{print $2}' /proc/meminfo)",
  "MA=$(awk '/^MemAvailable:/{print $2}' /proc/meminfo)",
  "DISK=$(df -B1 --output=size,used / | tail -n1)",
  `printf '%s %s %s %s %s\\n' "$LOAD" "$CORES" "$MT" "$MA" "$DISK"`,
].join("; ");

export interface CollectResult {
  /** Databases successfully sampled. */
  databases: number;
  /** Disk usage readings recorded — at most one per server and per
   *  `DISK_USAGE_INTERVAL_MS`, so far fewer than `servers`. */
  disks: number;
  /** Servers successfully sampled. */
  servers: number;
  /** Services successfully sampled. */
  services: number;
  /** Unreachable servers — their series will have a gap, and that's intentional. */
  skipped: string[];
}

interface HostSample {
  cpuCount: number;
  cpuLoad1: number;
  diskTotalBytes: number;
  diskUsedBytes: number;
  memoryTotalBytes: number;
  memoryUsedBytes: number;
}

/**
 * Parses `HOST_FACTS`'s output.
 *
 * Returns `null` as soon as a field is missing or isn't a number, rather
 * than substituting a zero: a half-true row is worse than a missing one,
 * since it gets plotted as a real measurement.
 */
export function parseHostFacts(stdout: string): HostSample | null {
  const parts = stdout.trim().split(WHITESPACE).map(Number);
  if (parts.length !== 6 || parts.some((n) => !Number.isFinite(n))) {
    return null;
  }
  const [load1, cores, memTotalKib, memAvailKib, diskTotal, diskUsed] =
    parts as [number, number, number, number, number, number];
  return {
    cpuCount: cores,
    cpuLoad1: load1,
    diskTotalBytes: diskTotal,
    diskUsedBytes: diskUsed,
    memoryTotalBytes: memTotalKib * KIB,
    // "Used" in the sense of what's unavailable to allocate, not in the
    // sense of `total - free`: cache counts toward `free` without being
    // truly unavailable, and showing a machine at 95% because it's caching
    // files would cause needless alarm.
    memoryUsedBytes: (memTotalKib - memAvailKib) * KIB,
  };
}

interface DockerStats {
  /**
   * Block IO breakdown.
   *
   * We read from `io_service_bytes_recursive` and sum by operation:
   * - op "Read"  -> read bytes
   * - op "Write" -> write bytes
   */
  blkio_stats?: {
    io_service_bytes_recursive?: Array<{
      op?: string;
      value?: number;
    }>;
  };
  cpu_stats?: {
    cpu_usage?: { total_usage?: number };
    online_cpus?: number;
    system_cpu_usage?: number;
  };
  memory_stats?: { limit?: number; usage?: number };
  /**
   * Per-interface network counters (what `docker stats` shows as NET I/O).
   *
   * Docker's exact shape varies a bit across versions, so everything here is
   * optional and we treat missing fields as "0 bytes".
   */
  networks?: Record<
    string,
    {
      rx_bytes?: number;
      tx_bytes?: number;
    }
  >;
  precpu_stats?: {
    cpu_usage?: { total_usage?: number };
    system_cpu_usage?: number;
  };
}

/**
 * The percentage of ONE core, the way `docker stats` computes it.
 *
 * Measured on a real VM: `stats({ stream: false })` returns POPULATED
 * `precpu_stats` — Docker takes two samples internally — so a single call is
 * enough. This wasn't a given: without them, no percentage would have been
 * computable without doubling the calls.
 *
 * Returns `null` if the system delta is zero, which happens on a container
 * that just started. Zero would be wrong: we don't know, so we don't plot.
 */
export function cpuPercent(stats: DockerStats): number | null {
  const cpuDelta =
    (stats.cpu_stats?.cpu_usage?.total_usage ?? 0) -
    (stats.precpu_stats?.cpu_usage?.total_usage ?? 0);
  const systemDelta =
    (stats.cpu_stats?.system_cpu_usage ?? 0) -
    (stats.precpu_stats?.system_cpu_usage ?? 0);
  if (systemDelta <= 0) {
    return null;
  }
  const cores = stats.cpu_stats?.online_cpus ?? 1;
  return (cpuDelta / systemDelta) * cores * 100;
}

const SWARM_SERVICE_LABEL = "com.docker.swarm.service.name";

/**
 * The Swarm task containers present on THIS node, indexed by service name.
 *
 * We start from what's ACTUALLY RUNNING HERE, not from what the database
 * says should be running here. The distinction had no effect as long as an
 * image stayed local to its node: `services.server_id` then designated both
 * the build location and the run location. With a registry, the image is
 * portable and Swarm does the placement — a relocated service would have
 * produced no row at all, and the dashboard would have shown "no data" for a
 * perfectly healthy service.
 *
 * Exactly the mistake the gap rule exists to prevent, except this one would
 * have been our own doing.
 *
 * A single `listContainers` per node, instead of one per service: also
 * fewer calls than before.
 */
async function swarmContainersByService(
  docker: DockerApi
): Promise<Map<string, { id: string; name: string }>> {
  const list = await docker.listContainers();
  const byService = new Map<string, { id: string; name: string }>();
  for (const c of list) {
    const serviceName = c.Labels?.[SWARM_SERVICE_LABEL];
    if (!serviceName || byService.has(serviceName)) {
      continue;
    }
    byService.set(serviceName, {
      id: c.Id,
      name: c.Names?.[0]?.replace(LEADING_SLASH, "") ?? serviceName,
    });
  }
  return byService;
}

/**
 * An aggregate from `/system/df`, as the daemon returns it.
 *
 * `Reclaimable` is distinct from `TotalSize` and isn't derived from it: a
 * layer still referenced by an in-use image isn't reclaimable.
 */
interface DfUsage {
  Reclaimable?: number;
  TotalCount?: number;
  TotalSize?: number;
}

interface DockerDf {
  BuildCacheUsage?: DfUsage;
  ContainerUsage?: DfUsage;
  ImageUsage?: DfUsage;
  VolumeUsage?: DfUsage;
}

type DiskSample = Omit<
  typeof serverDiskUsage.$inferInsert,
  "id" | "sampledAt" | "serverId"
>;

/**
 * The disk usage breakdown, in RAW BYTES.
 *
 * We read the API's aggregates (`ImageUsage`, `ContainerUsage`,
 * `VolumeUsage`, `BuildCacheUsage`) rather than `docker system df`'s output,
 * and this isn't a style preference. The CLI formats its sizes for the human
 * eye — "3.575GB" — and converting them back into a number costs two errors
 * at once: the precision lost to rounding, and the unit. **Measured on a
 * real VM: Docker's `HumanSize` is DECIMAL** (the API says 3,574,994,286,
 * the CLI says 3.575GB, i.e. 3.575×10⁹ to within 0.00%); reading it as 1024³
 * overestimates by 7.4% — a common confusion in this kind of calculation,
 * which also often keeps `reclaimable` as a string, hence incomparable.
 *
 * The API returns integers directly: nothing to parse, nothing to re-aggregate.
 *
 * **The "we don't know" test applies to the OBJECTS, never to the numbers
 * they contain.** The four aggregates appeared with **API 1.52** (Docker
 * 29) — measured, `/v1.51/system/df` only returns raw lists — so their
 * absence says "this daemon doesn't know how to break things down", and
 * there a gap is better than a machine that would look empty.
 *
 * Inside, it's the reverse: Docker serializes these fields with
 * `omitempty`, so that a NULL aggregate is an ABSENT field. Measured on the
 * VM right after a prune — `ImageUsage` and `ContainerUsage` no longer have
 * a `Reclaimable` at all, while `VolumeUsage` and `BuildCacheUsage` do have
 * one (and `BuildCacheUsage` has no `ActiveCount`, also zero). Treating
 * these absences as "unknown" made the whole function return `null`, so it
 * wrote NO usage data at all: the screen of a CLEAN machine showed "no
 * data", the message that says Noddle couldn't reach it. The bug predates
 * the prune feature and was only invisible because the dev VM always had
 * something reclaimable — pruning makes this the NORMAL state, hence the
 * fix here.
 */
export function parseDiskUsage(df: DockerDf): DiskSample | null {
  const images = df.ImageUsage;
  const containers = df.ContainerUsage;
  const volumes = df.VolumeUsage;
  const cache = df.BuildCacheUsage;
  if (!(images && containers && volumes && cache)) {
    return null;
  }

  return {
    buildCacheBytes: cache.TotalSize ?? 0,
    buildCacheCount: cache.TotalCount ?? 0,
    buildCacheReclaimableBytes: cache.Reclaimable ?? 0,
    containerBytes: containers.TotalSize ?? 0,
    containerCount: containers.TotalCount ?? 0,
    containerReclaimableBytes: containers.Reclaimable ?? 0,
    imageBytes: images.TotalSize ?? 0,
    imageCount: images.TotalCount ?? 0,
    imageReclaimableBytes: images.Reclaimable ?? 0,
    volumeBytes: volumes.TotalSize ?? 0,
    volumeCount: volumes.TotalCount ?? 0,
    volumeReclaimableBytes: volumes.Reclaimable ?? 0,
  };
}

/**
 * THIS node's disk usage, if it's due.
 *
 * "If it's due" is decided against the DATABASE, not an in-memory timer: a
 * worker that restarts picks up where it left off, same rule as `sweepBackups`.
 */
async function sampleDiskUsage(
  ctx: DeployContext,
  docker: DockerApi,
  serverId: string,
  result: CollectResult
): Promise<void> {
  const last = await ctx.db.query.serverDiskUsage.findFirst({
    orderBy: desc(serverDiskUsage.sampledAt),
    where: eq(serverDiskUsage.serverId, serverId),
  });
  if (last && Date.now() - last.sampledAt.getTime() < DISK_USAGE_INTERVAL_MS) {
    return;
  }

  if (await recordDiskUsage(ctx, docker, serverId)) {
    result.disks += 1;
  }
}

/**
 * Records disk usage NOW, without checking the cadence.
 *
 * The cadence belongs to the caller, and the two callers don't have the same
 * reason to record: the collector spaces out its reads because `/system/df`
 * is expensive, the prune takes one because it just changed the numbers.
 * Without this, the screen of a machine that was just pruned would keep
 * showing the old usage for ten minutes — a dashboard displaying a full disk
 * right after emptying it.
 *
 * Returns `false` when the daemon doesn't return the aggregates: a gap,
 * never zeros.
 */
export async function recordDiskUsage(
  ctx: DeployContext,
  docker: DockerApi,
  serverId: string
): Promise<boolean> {
  const usage = parseDiskUsage((await docker.df()) as DockerDf);
  if (!usage) {
    return false;
  }
  await ctx.db.insert(serverDiskUsage).values({ ...usage, serverId });
  return true;
}

interface IoTotals {
  blockReadBytes: number;
  blockWriteBytes: number;
  networkInBytes: number;
  networkOutBytes: number;
}

function ioTotalsFrom(stats: DockerStats): IoTotals {
  const network = stats.networks ?? {};
  const networkInBytes = Object.values(network).reduce(
    (sum, v) => sum + (v.rx_bytes ?? 0),
    0
  );
  const networkOutBytes = Object.values(network).reduce(
    (sum, v) => sum + (v.tx_bytes ?? 0),
    0
  );

  const blk = stats.blkio_stats?.io_service_bytes_recursive ?? [];
  let blockReadBytes = 0;
  let blockWriteBytes = 0;
  for (const e of blk) {
    const op = (e.op ?? "").toLowerCase();
    const value = e.value ?? 0;
    if (op.includes("read")) {
      blockReadBytes += value;
    } else if (op.includes("write")) {
      blockWriteBytes += value;
    }
  }

  return { blockReadBytes, blockWriteBytes, networkInBytes, networkOutBytes };
}

/**
 * Samples ONE container and writes its row.
 *
 * The owner is passed as-is: `service_metrics` carries two nullable foreign
 * keys of which exactly one is set, and it's the database's `check`
 * constraint that guarantees it — not caller discipline.
 *
 * Returns `false` when Docker doesn't give us enough to conclude. Zero would
 * be wrong: we don't know, so we don't plot.
 */
async function sampleContainer(
  ctx: DeployContext,
  docker: DockerApi,
  container: { id: string; name: string },
  owner: { databaseId: string } | { serviceId: string },
  serverIo?: IoTotals
): Promise<boolean> {
  const stats = (await docker
    .getContainer(container.id)
    .stats({ stream: false })) as DockerStats;

  const percent = cpuPercent(stats);
  const used = stats.memory_stats?.usage;
  if (percent === null || used === undefined) {
    return false;
  }

  const io = ioTotalsFrom(stats);

  await ctx.db.insert(serviceMetrics).values({
    ...owner,
    blockReadBytes: io.blockReadBytes,
    blockWriteBytes: io.blockWriteBytes,
    cpuPercent: percent,
    // 0 = no declared limit. We store what Docker returns rather than
    // substituting the host's memory, so "no limit" stays readable as such.
    memoryLimitBytes: stats.memory_stats?.limit ?? 0,
    memoryUsedBytes: used,
    networkInBytes: io.networkInBytes,
    networkOutBytes: io.networkOutBytes,
    taskName: container.name,
  });
  if (serverIo) {
    serverIo.blockReadBytes += io.blockReadBytes;
    serverIo.blockWriteBytes += io.blockWriteBytes;
    serverIo.networkInBytes += io.networkInBytes;
    serverIo.networkOutBytes += io.networkOutBytes;
  }
  return true;
}

/**
 * Databases RUNNING on this node, one sample each.
 *
 * Same path as services, and that's the fact that decided the shape at the
 * database level: a database engine IS a Swarm container, with the same
 * `docker stats` and the same four numbers. Nothing diverges, so nothing to
 * duplicate.
 *
 * The Swarm name is READ from the column (`swarmName`) and not recomputed,
 * unlike services: a database's name also names its volume, so it's fixed
 * at creation time — a decision already made.
 */
async function sampleDatabases(
  ctx: DeployContext,
  present: Map<string, { id: string; name: string }>,
  docker: DockerApi,
  result: CollectResult,
  serverIo?: IoTotals
): Promise<void> {
  const running = await ctx.db.query.databases.findMany({
    where: eq(databases.status, "running"),
  });

  for (const database of running) {
    const container = present.get(database.swarmName);
    if (!container) {
      continue;
    }
    // biome-ignore lint/performance/noAwaitInLoops: one container at a time, deliberately
    const sampled = await sampleContainer(
      ctx,
      docker,
      container,
      {
        databaseId: database.id,
      },
      serverIo
    );
    if (sampled) {
      result.databases += 1;
    }
  }
}

/** Services RUNNING on this node, one sample each. */
async function sampleServices(
  ctx: DeployContext,
  present: Map<string, { id: string; name: string }>,
  docker: DockerApi,
  result: CollectResult,
  serverIo?: IoTotals
): Promise<void> {
  // ALL running services, not just the ones for which this server is the
  // BUILD server: with a registry, Swarm places wherever it wants. It's the
  // container's presence on this node that decides, just below.
  const running = await ctx.db.query.services.findMany({
    where: eq(services.status, "running"),
  });

  for (const service of running) {
    const container = present.get(swarmServiceName(service));
    if (!container) {
      continue;
    }
    // biome-ignore lint/performance/noAwaitInLoops: one container at a time, deliberately
    const sampled = await sampleContainer(
      ctx,
      docker,
      container,
      {
        serviceId: service.id,
      },
      serverIo
    );
    if (sampled) {
      result.services += 1;
    }
  }
}

async function sampleServer(
  ctx: DeployContext,
  server: typeof servers.$inferSelect,
  result: CollectResult
): Promise<void> {
  const client = await ctx.connectTo(server);
  try {
    const facts = await exec(client, HOST_FACTS);
    const host = facts.code === 0 ? parseHostFacts(facts.stdout) : null;

    const serverIo: IoTotals = {
      blockReadBytes: 0,
      blockWriteBytes: 0,
      networkInBytes: 0,
      networkOutBytes: 0,
    };

    const docker = ctx.createDockerApi(client);
    // A SINGLE `listContainers` per node, shared by both readings: it's the
    // container's presence HERE that decides, for a database as for a
    // service, and querying it twice would learn nothing more.
    const present = await swarmContainersByService(docker);
    await sampleServices(ctx, present, docker, result, serverIo);
    await sampleDatabases(ctx, present, docker, result, serverIo);
    // LAST, and deliberately so: disk usage is the only reading we don't
    // take every pass, so the least essential. If it fails, everything
    // before it is already written.
    await sampleDiskUsage(ctx, docker, server.id, result);

    if (host) {
      await ctx.db.insert(serverMetrics).values({
        ...host,
        ...serverIo,
        serverId: server.id,
      });
      result.servers += 1;
    } else {
      // The command answered but not as expected: it's a gap, not a zero.
      // We count it as a skipped server.
      result.skipped.push(server.id);
    }
  } finally {
    disconnect(client);
  }
}

/**
 * A single collection pass.
 *
 * One server's failure doesn't block the others: each is isolated, and an
 * unreachable server produces a GAP in its series — visible as such —
 * instead of a made-up measurement.
 */
export async function collectMetrics(
  ctx: DeployContext
): Promise<CollectResult> {
  const result: CollectResult = {
    databases: 0,
    disks: 0,
    servers: 0,
    services: 0,
    skipped: [],
  };

  const connected = await ctx.db.query.servers.findMany({
    where: eq(servers.status, "connected"),
  });

  for (const server of connected) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: one machine at a time, deliberately
      await sampleServer(ctx, server, result);
    } catch {
      // Unreachable, SSH refused, Docker down: nothing is written, and
      // that's the intended behavior.
      result.skipped.push(server.id);
    }
  }

  await pruneMetrics(ctx);
  return result;
}

/** Deletes anything past the retention window. Three tables, one rule. */
export async function pruneMetrics(ctx: DeployContext): Promise<void> {
  const cutoff = new Date(Date.now() - RETENTION_MS);
  await ctx.db.delete(serverMetrics).where(lt(serverMetrics.sampledAt, cutoff));
  await ctx.db
    .delete(serviceMetrics)
    .where(lt(serviceMetrics.sampledAt, cutoff));
  await ctx.db
    .delete(serverDiskUsage)
    .where(lt(serverDiskUsage.sampledAt, cutoff));
}
