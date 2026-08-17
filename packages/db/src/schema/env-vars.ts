import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { createdAt, updatedAt } from "#schema/columns";
import { databases } from "#schema/databases";
import { services } from "#schema/services";

/**
 * The environment variables of a service OR a database.
 *
 * A single table rather than a second one for databases: the encryption,
 * its AAD, the diff before saving and the edit table are already written
 * here, and two copies would diverge. Same reasoning as previews, which
 * are ordinary `services` rather than a separate table.
 *
 * `service_id` and `database_id` are therefore both NULLABLE, and the
 * `check` constraint requires that EXACTLY one of them be set. Without it,
 * an orphaned row (both null) would be invisible from both sides and would
 * belong to nothing — it would survive the deletion of both the service
 * and the database, since no cascade would target it.
 */
export const envVars = pgTable(
  "env_vars",
  {
    createdAt,
    databaseId: uuid("database_id").references(() => databases.id, {
      onDelete: "cascade",
    }),
    id: uuid("id").primaryKey().defaultRandom(),

    // Drives the display (hidden in the UI) and the injection: prefer
    // `docker secret` so nothing leaks in `docker inspect`.
    isSecret: boolean("is_secret").notNull().default(false),
    key: text("key").notNull(),
    serviceId: uuid("service_id").references(() => services.id, {
      onDelete: "cascade",
    }),
    updatedAt,

    // Encrypted at rest, systematically — including for non-secret values.
    // A single code path, so no risk of forgetting.
    valueEncrypted: text("value_encrypted").notNull(),
  },
  (t) => [
    // PARTIAL, and that's necessary: an ordinary unique index on a nullable
    // column treats two NULLs as distinct, so `(NULL, 'PORT')` could repeat
    // as many times as there are databases.
    uniqueIndex("env_vars_service_key_idx")
      .on(t.serviceId, t.key)
      .where(sql`${t.serviceId} is not null`),
    uniqueIndex("env_vars_database_key_idx")
      .on(t.databaseId, t.key)
      .where(sql`${t.databaseId} is not null`),
    check(
      "env_vars_one_owner",
      sql`(${t.serviceId} is null) <> (${t.databaseId} is null)`
    ),
  ]
);
