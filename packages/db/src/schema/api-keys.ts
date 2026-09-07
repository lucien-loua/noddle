import { relations } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

import { user } from "#schema/auth";

export const apikey = pgTable(
  "apikey",
  {
    configId: text("config_id").default("default").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    expiresAt: timestamp("expires_at"),
    id: text("id").primaryKey(),
    key: text("key").notNull(),
    lastRefillAt: timestamp("last_refill_at"),
    lastRequest: timestamp("last_request"),
    metadata: text("metadata"),
    name: text("name"),
    permissions: text("permissions"),
    prefix: text("prefix"),
    rateLimitEnabled: boolean("rate_limit_enabled").default(true).notNull(),
    rateLimitMax: integer("rate_limit_max"),
    rateLimitTimeWindow: integer("rate_limit_time_window"),
    referenceId: text("reference_id").notNull(),
    refillAmount: integer("refill_amount"),
    refillInterval: integer("refill_interval"),
    remaining: integer("remaining"),
    requestCount: integer("request_count").default(0).notNull(),
    start: text("start"),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [
    index("apikey_key_idx").on(t.key),
    index("apikey_reference_idx").on(t.referenceId),
    index("apikey_config_idx").on(t.configId),
  ]
);

export const apikeyRelations = relations(apikey, ({ one }) => ({
  owner: one(user, {
    fields: [apikey.referenceId],
    references: [user.id],
  }),
}));
