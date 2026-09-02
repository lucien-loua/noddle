import {
  boolean,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { createdAt, updatedAt } from "#schema/columns";

export const notificationKind = pgEnum("notification_kind", [
  "webhook",
  "discord",
  "slack",
]);

export const notificationChannels = pgTable("notification_channels", {
  createdAt,
  enabled: boolean("enabled").notNull().default(true),
  id: uuid("id").primaryKey().defaultRandom(),
  kind: notificationKind("kind").notNull(),

  lastError: text("last_error"),
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),

  name: text("name").notNull(),

  notifySuccess: boolean("notify_success").notNull().default(false),

  updatedAt,

  urlEncrypted: text("url_encrypted").notNull(),
});
