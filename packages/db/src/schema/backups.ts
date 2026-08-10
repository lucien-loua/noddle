import {
  bigint,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt } from "#schema/columns";
import { databases } from "#schema/databases";
import { s3Destinations } from "#schema/s3-destinations";

export const backupStatus = pgEnum("backup_status", [
  "queued",
  "running",
  // The object is in the bucket AND the dumper exited 0. Both: a truncated
  // dump uploads perfectly, measured against RustFS. Only the exit code
  // distinguishes a backup from half a backup.
  "completed",
  "failed",
]);

export const backupKind = pgEnum("backup_kind", [
  "manual",
  "scheduled",
  // Taken automatically just before a restore. It is the safety net for the
  // product's only irreversible operation.
  "pre_restore",
]);

export const backups = pgTable(
  "backups",
  {
    createdAt,
    databaseId: uuid("database_id")
      .notNull()
      .references(() => databases.id, { onDelete: "cascade" }),

    // WHERE the object actually went.
    //
    // Without this column, `object_key` alone assumed there was only one
    // bucket: as soon as there are two, a restore would look up the key in the
    // wrong one, and retention would delete from the wrong one too.
    // `restrict` not `set null`: deleting a destination that still holds
    // backups would silently make those rows unrestorable — the refusal is
    // explicit. `null` only on rows from BEFORE this column, which had only
    // one possible destination.
    destinationId: uuid("destination_id").references(() => s3Destinations.id, {
      onDelete: "restrict",
    }),
    errorMessage: text("error_message"),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    id: uuid("id").primaryKey().defaultRandom(),
    kind: backupKind("kind").notNull().default("manual"),

    // Decided when the row is created, before a single byte: without it we
    // would not know what to delete if the job dies in between.
    objectKey: text("object_key").notNull(),

    // Taken from a HEAD after the fact, never from the stream's byte counter:
    // it is what the bucket actually holds.
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }),
    status: backupStatus("status").notNull().default("queued"),
  },
  (t) => [index("backups_database_created_idx").on(t.databaseId, t.createdAt)]
);
