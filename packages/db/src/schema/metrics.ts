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

export const serverMetrics = pgTable(
  "server_metrics",
  {
    blockReadBytes: bigint("block_read_bytes", { mode: "number" }).notNull(),
    blockWriteBytes: bigint("block_write_bytes", { mode: "number" }).notNull(),
    cpuCount: bigint("cpu_count", { mode: "number" }).notNull(),
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
  (t) => [index("server_metrics_server_time_idx").on(t.serverId, t.sampledAt)]
);

export const serviceMetrics = pgTable(
  "service_metrics",
  {
    blockReadBytes: bigint("block_read_bytes", { mode: "number" }).notNull(),
    blockWriteBytes: bigint("block_write_bytes", { mode: "number" }).notNull(),
    cpuPercent: real("cpu_percent").notNull(),
    databaseId: uuid("database_id").references(() => databases.id, {
      onDelete: "cascade",
    }),
    id: uuid("id").primaryKey().defaultRandom(),
    memoryLimitBytes: bigint("memory_limit_bytes", {
      mode: "number",
    }).notNull(),
    memoryUsedBytes: bigint("memory_used_bytes", { mode: "number" }).notNull(),
    networkInBytes: bigint("network_in_bytes", { mode: "number" }).notNull(),
    networkOutBytes: bigint("network_out_bytes", { mode: "number" }).notNull(),
    sampledAt: timestamp("sampled_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    serviceId: uuid("service_id").references(() => services.id, {
      onDelete: "cascade",
    }),

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

export const serverDiskUsage = pgTable(
  "server_disk_usage",
  {
    buildCacheBytes: bigint("build_cache_bytes", { mode: "number" }).notNull(),
    buildCacheCount: bigint("build_cache_count", { mode: "number" }).notNull(),
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
