import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  pgTable,
  real,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { databases } from "#schema/databases";
import { servers } from "#schema/servers";
import { services } from "#schema/services";

/**
 * The state of a machine at a point in time.
 *
 * No column is nullable for convenience: a missing value should prevent
 * the row from being written, not produce a half-empty sample. **A gap in
 * the series means "we weren't looking", and that's information** —
 * confusing it with a zero would make it look like a machine was fine
 * while it was actually unreachable.
 */
export const serverMetrics = pgTable(
  "server_metrics",
  {
    /**
     * Host-level sum across all sampled containers on this node, as `docker
     * stats` reports them.
     *
     * Unit is bytes (base-10); the UI formats it in kB/MB/GB.
     */
    blockReadBytes: bigint("block_read_bytes", { mode: "number" }).notNull(),
    blockWriteBytes: bigint("block_write_bytes", { mode: "number" }).notNull(),
    /** Number of cores, so load can be interpreted without guessing. */
    cpuCount: bigint("cpu_count", { mode: "number" }).notNull(),
    /** 1-minute load average, as reported by `/proc/loadavg`. */
    cpuLoad1: real("cpu_load1").notNull(),
    diskTotalBytes: bigint("disk_total_bytes", { mode: "number" }).notNull(),
    diskUsedBytes: bigint("disk_used_bytes", { mode: "number" }).notNull(),
    id: uuid("id").primaryKey().defaultRandom(),
    memoryTotalBytes: bigint("memory_total_bytes", {
      mode: "number",
    }).notNull(),
    memoryUsedBytes: bigint("memory_used_bytes", { mode: "number" }).notNull(),
    networkInBytes: bigint("network_in_bytes", { mode: "number" }).notNull(),
    networkOutBytes: bigint("network_out_bytes", { mode: "number" }).notNull(),
    sampledAt: timestamp("sampled_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
  },
  // The index is on (server, timestamp): every read is "the latest window
  // for THIS server", never a global scan.
  (t) => [index("server_metrics_server_time_idx").on(t.serverId, t.sampledAt)]
);

/**
 * The state of a service OR a database at a point in time.
 *
 * A single table, because the SHAPE doesn't diverge: a database engine IS
 * a container, sampled by the same `docker stats`, with the same four
 * numbers, the same cadence, the same retention and the same index. A
 * second table would only have duplicated identical columns. Same
 * reasoning as `env_vars`, whose exact shape this file reuses —
 * `service_id` and `database_id` both NULLABLE, and a `check` constraint
 * requiring EXACTLY one of them. Without it, an orphaned row would survive
 * both cascades and belong to nothing.
 *
 * **The table name stays `service_metrics` and now only describes half of
 * its content.** Noted here rather than fixed in passing: renaming it is a
 * separate migration, unrelated to the capability being added.
 *
 * `memoryLimitBytes` can be 0: a container with no declared limit is
 * bounded by the machine. We store what Docker returns rather than
 * substituting the host's memory, so "no limit" stays legible as such.
 */
export const serviceMetrics = pgTable(
  "service_metrics",
  {
    /** Block I/O read bytes across container block devices. */
    blockReadBytes: bigint("block_read_bytes", { mode: "number" }).notNull(),
    /** Block I/O write bytes across container block devices. */
    blockWriteBytes: bigint("block_write_bytes", { mode: "number" }).notNull(),
    /** Percentage of ONE core, as computed by `docker stats`. */
    cpuPercent: real("cpu_percent").notNull(),
    databaseId: uuid("database_id").references(() => databases.id, {
      onDelete: "cascade",
    }),
    id: uuid("id").primaryKey().defaultRandom(),
    memoryLimitBytes: bigint("memory_limit_bytes", {
      mode: "number",
    }).notNull(),
    memoryUsedBytes: bigint("memory_used_bytes", { mode: "number" }).notNull(),
    /**
     * Container-level sum across all network interfaces, as `docker stats`
     * reports them.
     *
     * Unit is bytes (base-10); the UI formats it in kB/MB/GB.
     */
    networkInBytes: bigint("network_in_bytes", { mode: "number" }).notNull(),
    networkOutBytes: bigint("network_out_bytes", { mode: "number" }).notNull(),
    sampledAt: timestamp("sampled_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    serviceId: uuid("service_id").references(() => services.id, {
      onDelete: "cascade",
    }),

    /**
     * The name of the sampled Swarm task.
     *
     * Kept because a redeployed service changes container: without it, a
     * sudden memory drop reads as a fixed leak when it's simply a new task
     * starting up.
     */
    taskName: text("task_name").notNull(),
  },
  (t) => [
    index("service_metrics_service_time_idx").on(t.serviceId, t.sampledAt),
    index("service_metrics_database_time_idx").on(t.databaseId, t.sampledAt),
    check(
      "service_metrics_one_owner",
      sql`(${t.serviceId} is null) <> (${t.databaseId} is null)`
    ),
  ]
);

/**
 * A machine's disk breakdown, as `docker system df` sees it.
 *
 * Table SEPARATE from `server_metrics` even though both describe the same
 * machine, and the reason is the rhythm: `/proc` reads in a few
 * milliseconds, the `/system/df` API asks the daemon to walk its layer
 * store. Measured on a 2 GB VM, Docker 29: 0.65s of work and a 131 KB
 * response to extract twelve integers from. Folding it into
 * `server_metrics` would impose that cost every minute; kept separate,
 * each keeps its own cadence.
 *
 * A single ROW per sample, four categories inside it, rather than one row
 * per category: a half-written breakdown would read as a machine whose
 * volumes weigh nothing. The wide row makes that atomicity free, without a
 * transaction.
 *
 * Disk is PER NODE and doesn't aggregate — hence its place on a server's
 * detail page, and nowhere else.
 */
export const serverDiskUsage = pgTable(
  "server_disk_usage",
  {
    buildCacheBytes: bigint("build_cache_bytes", { mode: "number" }).notNull(),
    buildCacheCount: bigint("build_cache_count", { mode: "number" }).notNull(),
    /** What `docker builder prune` would return. Distinct from the total
     *  size: a layer still referenced by an image can't be reclaimed. */
    buildCacheReclaimableBytes: bigint("build_cache_reclaimable_bytes", {
      mode: "number",
    }).notNull(),
    containerBytes: bigint("container_bytes", { mode: "number" }).notNull(),
    containerCount: bigint("container_count", { mode: "number" }).notNull(),
    containerReclaimableBytes: bigint("container_reclaimable_bytes", {
      mode: "number",
    }).notNull(),
    id: uuid("id").primaryKey().defaultRandom(),
    imageBytes: bigint("image_bytes", { mode: "number" }).notNull(),
    imageCount: bigint("image_count", { mode: "number" }).notNull(),
    imageReclaimableBytes: bigint("image_reclaimable_bytes", {
      mode: "number",
    }).notNull(),
    sampledAt: timestamp("sampled_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    volumeBytes: bigint("volume_bytes", { mode: "number" }).notNull(),
    volumeCount: bigint("volume_count", { mode: "number" }).notNull(),
    volumeReclaimableBytes: bigint("volume_reclaimable_bytes", {
      mode: "number",
    }).notNull(),
  },
  (t) => [
    index("server_disk_usage_server_time_idx").on(t.serverId, t.sampledAt),
  ]
);
