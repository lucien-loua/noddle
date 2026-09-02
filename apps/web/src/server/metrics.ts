import {
  serverDiskUsage,
  serverMetrics,
  servers,
  serviceMetrics,
} from "@noddle/db/schema";
import {
  databaseMetricsRequestSchema,
  serviceMetricsRequestSchema,
} from "@noddle/shared/validation/metrics";
import { createServerFn } from "@tanstack/react-start";
import { and, asc, desc, eq, gte } from "drizzle-orm";

import { db } from "@/lib/db.server";
import { requireSession } from "@/lib/session.server";

const WINDOW_MS = 6 * 60 * 60 * 1000;

export interface MetricPoint {
  blockReadBytes: number;
  blockWriteBytes: number;
  cpuLoad1: number;
  diskUsedRatio: number;
  memoryUsedRatio: number;
  networkInBytes: number;
  networkOutBytes: number;
  sampledAt: string;
}

export interface ServerSeries {
  cpuCount: number;
  latest: MetricPoint | null;
  points: MetricPoint[];
  serverId: string;
  serverName: string;
}

export const getServerMetrics = createServerFn({ method: "GET" }).handler(
  async (): Promise<ServerSeries[]> => {
    await requireSession();
    const since = new Date(Date.now() - WINDOW_MS);

    const machines = await db.query.servers.findMany({
      orderBy: servers.name,
    });

    const out: ServerSeries[] = [];
    for (const machine of machines) {
      const rows = await db.query.serverMetrics.findMany({
        orderBy: asc(serverMetrics.sampledAt),
        where: and(
          eq(serverMetrics.serverId, machine.id),
          gte(serverMetrics.sampledAt, since)
        ),
      });

      const points: MetricPoint[] = rows.map((r) => ({
        blockReadBytes: r.blockReadBytes,
        blockWriteBytes: r.blockWriteBytes,
        cpuLoad1: r.cpuLoad1,
        diskUsedRatio:
          r.diskTotalBytes > 0 ? r.diskUsedBytes / r.diskTotalBytes : 0,
        memoryUsedRatio:
          r.memoryTotalBytes > 0 ? r.memoryUsedBytes / r.memoryTotalBytes : 0,
        networkInBytes: r.networkInBytes,
        networkOutBytes: r.networkOutBytes,
        sampledAt: r.sampledAt.toISOString(),
      }));

      out.push({
        cpuCount: rows.at(-1)?.cpuCount ?? 1,
        latest: points.at(-1) ?? null,
        points,
        serverId: machine.id,
        serverName: machine.name,
      });
    }
    return out;
  }
);

export interface ServicePoint {
  blockReadBytes: number;
  blockWriteBytes: number;
  cpuPercent: number;
  memoryUsedBytes: number;
  memoryUsedRatio: number | null;
  networkInBytes: number;
  networkOutBytes: number;
  sampledAt: string;
  taskName: string;
}

export interface ServiceSeries {
  latest: ServicePoint | null;
  points: ServicePoint[];
  restarts: number;
}

function seriesFrom(
  rows: (typeof serviceMetrics.$inferSelect)[]
): ServiceSeries {
  const points: ServicePoint[] = rows.map((r) => ({
    blockReadBytes: r.blockReadBytes,
    blockWriteBytes: r.blockWriteBytes,
    cpuPercent: r.cpuPercent,
    memoryUsedBytes: r.memoryUsedBytes,
    memoryUsedRatio:
      r.memoryLimitBytes > 0 ? r.memoryUsedBytes / r.memoryLimitBytes : null,
    networkInBytes: r.networkInBytes,
    networkOutBytes: r.networkOutBytes,
    sampledAt: r.sampledAt.toISOString(),
    taskName: r.taskName,
  }));

  return {
    latest: points.at(-1) ?? null,
    points,
    restarts: new Set(rows.map((r) => r.taskName)).size,
  };
}

export const getServiceMetrics = createServerFn({ method: "GET" })
  .validator(serviceMetricsRequestSchema)
  .handler(async ({ data }): Promise<ServiceSeries> => {
    await requireSession();
    const since = new Date(Date.now() - WINDOW_MS);

    const rows = await db.query.serviceMetrics.findMany({
      orderBy: asc(serviceMetrics.sampledAt),
      where: and(
        eq(serviceMetrics.serviceId, data.serviceId),
        gte(serviceMetrics.sampledAt, since)
      ),
    });

    return seriesFrom(rows);
  });

export const getDatabaseMetrics = createServerFn({ method: "GET" })
  .validator(databaseMetricsRequestSchema)
  .handler(async ({ data }): Promise<ServiceSeries> => {
    await requireSession();
    const windowHours = Number(data.windowHours);
    const since = new Date(Date.now() - windowHours * 60 * 60 * 1000);

    const rows = await db.query.serviceMetrics.findMany({
      orderBy: asc(serviceMetrics.sampledAt),
      where: and(
        eq(serviceMetrics.databaseId, data.databaseId),
        gte(serviceMetrics.sampledAt, since)
      ),
    });

    return seriesFrom(rows);
  });

export type DiskCategoryKey =
  | "buildCache"
  | "containers"
  | "images"
  | "volumes";

export interface DiskCategory {
  bytes: number;
  count: number;
  key: DiskCategoryKey;
  reclaimableBytes: number;
}

export interface ServerDisk {
  categories: DiskCategory[];
  sampledAt: string;
  serverId: string;
}

export const getServerDiskUsage = createServerFn({ method: "GET" }).handler(
  async (): Promise<ServerDisk[]> => {
    await requireSession();

    const machines = await db.query.servers.findMany({
      orderBy: servers.name,
    });

    const out: ServerDisk[] = [];
    for (const machine of machines) {
      const row = await db.query.serverDiskUsage.findFirst({
        orderBy: desc(serverDiskUsage.sampledAt),
        where: eq(serverDiskUsage.serverId, machine.id),
      });
      if (!row) {
        continue;
      }
      out.push({
        categories: [
          {
            bytes: row.imageBytes,
            count: row.imageCount,
            key: "images",
            reclaimableBytes: row.imageReclaimableBytes,
          },
          {
            bytes: row.containerBytes,
            count: row.containerCount,
            key: "containers",
            reclaimableBytes: row.containerReclaimableBytes,
          },
          {
            bytes: row.volumeBytes,
            count: row.volumeCount,
            key: "volumes",
            reclaimableBytes: row.volumeReclaimableBytes,
          },
          {
            bytes: row.buildCacheBytes,
            count: row.buildCacheCount,
            key: "buildCache",
            reclaimableBytes: row.buildCacheReclaimableBytes,
          },
        ],
        sampledAt: row.sampledAt.toISOString(),
        serverId: machine.id,
      });
    }
    return out;
  }
);
