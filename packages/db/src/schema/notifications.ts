import {
  boolean,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { createdAt, updatedAt } from "#schema/columns";

/**
 * The same delivery mechanism for all three: a JSON POST. Only the SHAPE of
 * the payload changes, because Discord and Slack each impose their own.
 * `webhook` is Noddle's raw form, the one you wire up to anything else.
 */
export const notificationKind = pgEnum("notification_kind", [
  "webhook",
  "discord",
  "slack",
]);

export const notificationChannels = pgTable("notification_channels", {
  createdAt,
  /** Disabled without being deleted: we keep the URL and the error history. */
  enabled: boolean("enabled").notNull().default(true),
  id: uuid("id").primaryKey().defaultRandom(),
  kind: notificationKind("kind").notNull(),

  /**
   * The last delivery error, and the last success.
   *
   * This is the heart of the matter, not an ornament: a notification that
   * fails SILENTLY is worse than no notification at all — you believe
   * you're being watched over. These two columns are what let the screen
   * say "this channel hasn't sent anything in three days" instead of
   * letting you believe everything is calm.
   */
  lastError: text("last_error"),
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),

  name: text("name").notNull(),

  /**
   * Unchecked by default. Notifying on every successful deployment is the
   * surest way to make the channel invisible the day it carries a failure.
   */
  notifySuccess: boolean("notify_success").notNull().default(false),

  updatedAt,

  /**
   * Encrypted at rest: a Discord or Slack webhook URL IS a secret — whoever
   * holds it can post to the channel. The rule is already stated in
   * CLAUDE.md for SSH keys and environment variables.
   */
  urlEncrypted: text("url_encrypted").notNull(),
});
