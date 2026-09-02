import { index, pgEnum, pgTable, text, uuid } from "drizzle-orm/pg-core";

import { user } from "#schema/auth";
import { createdAt } from "#schema/columns";

export const auditOutcome = pgEnum("audit_outcome", ["allowed", "denied"]);

export const auditLog = pgTable(
  "audit_log",
  {
    action: text("action").notNull(),

    actorEmail: text("actor_email").notNull(),
    actorUserId: text("actor_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt,
    id: uuid("id").primaryKey().defaultRandom(),

    ipAddress: text("ip_address"),
    outcome: auditOutcome("outcome").notNull(),
    resource: text("resource").notNull(),

    resourceId: text("resource_id"),
    resourceName: text("resource_name"),

    role: text("role"),
    userAgent: text("user_agent"),
  },
  (t) => [
    index("audit_log_created_idx").on(t.createdAt),
    index("audit_log_actor_idx").on(t.actorUserId),
  ]
);
