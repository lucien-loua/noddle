import {
  databases,
  serverDiskUsage,
  serverMetrics,
  servers,
  serviceMetrics,
  services,
} from "@noddle/db/schema";
import { swarmServiceName } from "@noddle/shared/swarm-names";
import { disconnect, exec } from "@noddle/ssh-executor";
import type { DockerApi } from "@noddle/ssh-executor";
import { desc, eq, lt } from "drizzle-orm";

import type { DeployContext } from "#runtime-context";

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const DISK_USAGE_INTERVAL_MS = 10 * 60 * 1000;

const KIB = 1024;
const WHITESPACE = /\s+/;
const LEADING_SLASH = /^\//;

const HOST_FACTS = [
  "LOAD=$(awk '{print $1}' /proc/loadavg)",
  "CORES=$(nproc)",
  "MT=$(awk '/^MemTotal:/{print $2}' /proc/meminfo)",
  "MA=$(awk '/^MemAvailable:/{print $2}' /proc/meminfo)",
  "DISK=$(df -B1 --output=size,used / | tail -n1)",
  `printf '%s %s %s %s %s\\n' "$LOAD" "$CORES" "$MT" "$MA" "$DISK"`,
].join("; ");

export interface CollectResult {
  databases: number;
  disks: number;
  servers: number;
  services: number;
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
    memoryUsedBytes: (memTotalKib - memAvailKib) * KIB,
  };
}

interface DockerStats {
  blkio_stats?: {
    io_service_bytes_recursive?: {
      op?: string;
      value?: number;
    }[];
  };
  cpu_stats?: {
    cpu_usage?: { total_usage?: number };
    online_cpus?: number;
    system_cpu_usage?: number;
  };
  memory_stats?: { limit?: number; usage?: number };
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

async function sampleServices(
  ctx: DeployContext,
  present: Map<string, { id: string; name: string }>,
  docker: DockerApi,
  result: CollectResult,
  serverIo?: IoTotals
): Promise<void> {
  const running = await ctx.db.query.services.findMany({
    where: eq(services.status, "running"),
  });

  for (const service of running) {
    const container = present.get(swarmServiceName(service));
    if (!container) {
      continue;
    }
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
    const present = await swarmContainersByService(docker);
    await sampleServices(ctx, present, docker, result, serverIo);
    await sampleDatabases(ctx, present, docker, result, serverIo);
    await sampleDiskUsage(ctx, docker, server.id, result);

    if (host) {
      await ctx.db.insert(serverMetrics).values({
        ...host,
        ...serverIo,
        serverId: server.id,
      });
      result.servers += 1;
    } else {
      result.skipped.push(server.id);
    }
  } finally {
    disconnect(client);
  }
}

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
      await sampleServer(ctx, server, result);
    } catch {
      result.skipped.push(server.id);
    }
  }

  await pruneMetrics(ctx);
  return result;
}

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
