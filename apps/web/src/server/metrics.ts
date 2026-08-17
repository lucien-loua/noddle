import { serverDiskUsage, serverMetrics, servers, serviceMetrics } from "@noddle/db/schema";
import {
  databaseMetricsRequestSchema,
  serviceMetricsRequestSchema,
} from "@noddle/shared/validation/metrics";
import { createServerFn } from "@tanstack/react-start";
import { and, asc, desc, eq, gte } from "drizzle-orm";

import { db } from "@/lib/db.server";
import { requireSession } from "@/lib/session.server";

/** The displayed window. Six hours answers "what happened overnight". */
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
  /** The most recent one, or `null` if nothing was collected in the window. */
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
      // biome-ignore lint/performance/noAwaitInLoops: one machine at a time, deliberately
      const rows = await db.query.serverMetrics.findMany({
        orderBy: asc(serverMetrics.sampledAt),
        where: and(eq(serverMetrics.serverId, machine.id), gte(serverMetrics.sampledAt, since)),
      });

      const points: MetricPoint[] = rows.map((r) => ({
        blockReadBytes: r.blockReadBytes,
        blockWriteBytes: r.blockWriteBytes,
        cpuLoad1: r.cpuLoad1,
        // Ratios rather than bytes: that's what the screen shows, and
        // converting it here keeps every component from redoing the
        // division — so only one place could ever get the denominator
        // wrong.
        diskUsedRatio: r.diskTotalBytes > 0 ? r.diskUsedBytes / r.diskTotalBytes : 0,
        memoryUsedRatio: r.memoryTotalBytes > 0 ? r.memoryUsedBytes / r.memoryTotalBytes : 0,
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
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// per service
// ─────────────────────────────────────────────────────────────────────────────

export interface ServicePoint {
  blockReadBytes: number;
  blockWriteBytes: number;
  cpuPercent: number;
  memoryUsedBytes: number;
  /** `null` when no limit is declared: the container is bounded by the
   *  machine. Distinct from 0, which would mean "zero limit". */
  memoryUsedRatio: number | null;
  networkInBytes: number;
  networkOutBytes: number;
  sampledAt: string;
  /** Changes on every redeploy. See `ServiceSeries.restarts`. */
  taskName: string;
}

export interface ServiceSeries {
  latest: ServicePoint | null;
  points: ServicePoint[];
  /**
   * Number of distinct tasks in the window.
   *
   * Beyond 1, the series spans several successive containers: a sudden drop
   * in memory reads like a fixed leak when it's actually a new task
   * starting. The screen says so rather than letting you draw the wrong
   * conclusion.
   */
  restarts: number;
}

/** The raw rows shaped for display. Shared by both reads: two copies would
 *  eventually diverge on `memoryUsedRatio`'s denominator. */
function seriesFrom(rows: (typeof serviceMetrics.$inferSelect)[]): ServiceSeries {
  const points: ServicePoint[] = rows.map((r) => ({
    blockReadBytes: r.blockReadBytes,
    blockWriteBytes: r.blockWriteBytes,
    cpuPercent: r.cpuPercent,
    memoryUsedBytes: r.memoryUsedBytes,
    memoryUsedRatio: r.memoryLimitBytes > 0 ? r.memoryUsedBytes / r.memoryLimitBytes : null,
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
        gte(serviceMetrics.sampledAt, since),
      ),
    });

    return seriesFrom(rows);
  });

/**
 * The same series, for a database.
 *
 * A separate function rather than an "owner" parameter on the previous one:
 * both read the SAME table but not the same column, and a schema that
 * accepted either one would let a request through with neither of them —
 * so an unfiltered read. The table is shared, the entry point is not.
 */
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
        gte(serviceMetrics.sampledAt, since),
      ),
    });

    return seriesFrom(rows);
  });

// ─────────────────────────────────────────────────────────────────────────────
// disk breakdown
// ─────────────────────────────────────────────────────────────────────────────

export type DiskCategoryKey = "buildCache" | "containers" | "images" | "volumes";

export interface DiskCategory {
  bytes: number;
  count: number;
  key: DiskCategoryKey;
  /** What a `prune` would reclaim. NEVER derived from `bytes`: a layer
   *  still referenced by an in-use image can't be reclaimed. */
  reclaimableBytes: number;
}

export interface ServerDisk {
  categories: DiskCategory[];
  sampledAt: string;
  serverId: string;
}

/**
 * The latest known breakdown for each machine.
 *
 * `null` for a machine with no reading, and definitely NOT four zeros: a
 * machine with nothing on it reads as "it's empty", not "we haven't
 * looked". Same rule as the series, here on a single point.
 *
 * The guard is `requireSession`, like the metrics read just above, and
 * that's deliberate rather than an oversight. `requirePermission` would be
 * the natural instinct — that's what `getEnvVars` was missing — but the
 * test that tells the two cases apart is "does a role exist that does NOT
 * have this permission". For `envVar: read`, yes: `deployer` doesn't have
 * it, hence a real hole. For `server: read`, no — all four roles have it —
 * so the guard wouldn't turn anyone away and would only add an audit line
 * on every page view. The log only keeps the last 200: that's exactly how
 * /audit ended up burying its own signal.
 */
export const getServerDiskUsage = createServerFn({ method: "GET" }).handler(
  async (): Promise<ServerDisk[]> => {
    await requireSession();

    const machines = await db.query.servers.findMany({
      orderBy: servers.name,
    });

    const out: ServerDisk[] = [];
    for (const machine of machines) {
      // biome-ignore lint/performance/noAwaitInLoops: one machine at a time, deliberately
      const row = await db.query.serverDiskUsage.findFirst({
        orderBy: desc(serverDiskUsage.sampledAt),
        where: eq(serverDiskUsage.serverId, machine.id),
      });
      if (!row) {
        continue;
      }
      out.push({
        // The order matches `docker system df` itself, and it's FIXED:
        // sorted by size, a segment would swap places between one reading
        // and the next, and the bar would stop being comparable to itself.
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
  },
);
