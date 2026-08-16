import {
  bigint,
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { backupKind, backupStatus } from "#schema/backups";
import { createdAt, updatedAt } from "#schema/columns";
import { s3Destinations } from "#schema/s3-destinations";
import { services } from "#schema/services";

/** Scheduled tar backup of a Docker volume attached to a service. */
export const volumeBackupConfigs = pgTable(
  "volume_backup_configs",
  {
    createdAt,
    destinationId: uuid("destination_id")
      .notNull()
      .references(() => s3Destinations.id, { onDelete: "restrict" }),
    enabled: boolean("enabled").notNull().default(true),
    id: uuid("id").primaryKey().defaultRandom(),
    keepLatestCount: integer("keep_latest_count"),
    /** Container path the volume is mounted at — informational for restore. */
    mountPath: text("mount_path"),
    prefix: text("prefix").notNull().default(""),
    schedule: text("schedule").notNull(),
    serviceId: uuid("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    updatedAt,
    /** Docker volume name on the service's server (for example `hello-data-abc123`). */
    volumeName: text("volume_name").notNull(),
  },
  (t) => [index("volume_backup_configs_service_idx").on(t.serviceId)]
);

export const volumeBackups = pgTable(
  "volume_backups",
  {
    configId: uuid("config_id").references(() => volumeBackupConfigs.id, {
      onDelete: "set null",
    }),
    createdAt,
    destinationId: uuid("destination_id").references(() => s3Destinations.id, {
      onDelete: "restrict",
    }),
    errorMessage: text("error_message"),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    id: uuid("id").primaryKey().defaultRandom(),
    kind: backupKind("kind").notNull().default("manual"),
    objectKey: text("object_key").notNull(),
    serviceId: uuid("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }),
    status: backupStatus("status").notNull().default("queued"),
    /** Docker volume tar'd on the service's server — denormalized from config at enqueue. */
    volumeName: text("volume_name").notNull(),
  },
  (t) => [
    index("volume_backups_service_created_idx").on(t.serviceId, t.createdAt),
    index("volume_backups_config_created_idx").on(t.configId, t.createdAt),
  ]
);
