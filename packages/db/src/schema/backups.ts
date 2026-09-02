import {
  bigint,
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { createdAt, updatedAt } from "#schema/columns";
import { databases } from "#schema/databases";
import { s3Destinations } from "#schema/s3-destinations";

export const backupStatus = pgEnum("backup_status", [
  "queued",
  "running",
  "completed",
  "failed",
]);

export const backupKind = pgEnum("backup_kind", [
  "manual",
  "scheduled",
  "pre_restore",
]);

export const backupConfigs = pgTable(
  "backup_configs",
  {
    createdAt,
    databaseId: uuid("database_id")
      .notNull()
      .references(() => databases.id, { onDelete: "cascade" }),
    databaseName: text("database_name").notNull(),
    destinationId: uuid("destination_id")
      .notNull()
      .references(() => s3Destinations.id, { onDelete: "restrict" }),
    enabled: boolean("enabled").notNull().default(true),
    id: uuid("id").primaryKey().defaultRandom(),
    keepLatestCount: integer("keep_latest_count"),
    prefix: text("prefix").notNull().default(""),
    schedule: text("schedule").notNull(),
    updatedAt,
  },
  (t) => [index("backup_configs_database_idx").on(t.databaseId)]
);

export const backups = pgTable(
  "backups",
  {
    configId: uuid("config_id").references(() => backupConfigs.id, {
      onDelete: "set null",
    }),
    createdAt,
    databaseId: uuid("database_id")
      .notNull()
      .references(() => databases.id, { onDelete: "cascade" }),

    destinationId: uuid("destination_id").references(() => s3Destinations.id, {
      onDelete: "restrict",
    }),
    errorMessage: text("error_message"),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    id: uuid("id").primaryKey().defaultRandom(),
    kind: backupKind("kind").notNull().default("manual"),

    objectKey: text("object_key").notNull(),

    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }),
    status: backupStatus("status").notNull().default("queued"),
  },
  (t) => [
    index("backups_database_created_idx").on(t.databaseId, t.createdAt),
    index("backups_config_created_idx").on(t.configId, t.createdAt),
  ]
);
