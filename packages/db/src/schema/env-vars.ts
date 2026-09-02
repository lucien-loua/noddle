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

export const envVars = pgTable(
  "env_vars",
  {
    createdAt,
    databaseId: uuid("database_id").references(() => databases.id, {
      onDelete: "cascade",
    }),
    id: uuid("id").primaryKey().defaultRandom(),

    isSecret: boolean("is_secret").notNull().default(false),
    key: text("key").notNull(),
    serviceId: uuid("service_id").references(() => services.id, {
      onDelete: "cascade",
    }),
    updatedAt,

    valueEncrypted: text("value_encrypted").notNull(),
  },
  (t) => [
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
