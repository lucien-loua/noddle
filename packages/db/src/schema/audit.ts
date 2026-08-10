import { index, pgEnum, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { user } from "#schema/auth";
import { createdAt } from "#schema/columns";

export const auditOutcome = pgEnum("audit_outcome", ["allowed", "denied"]);

export const auditLog = pgTable(
  "audit_log",
  {
    /**
     * Action and resource, as TEXT not an enum.
     *
     * They are already typed at the call site — `Permission` forbids
     * `server: ["deploy"]`, which does not exist. Freezing them as a Postgres
     * enum too would force a migration on every new permission, for a guarantee
     * the type already gives on the write side. And an audit log must be able
     * to re-read rows written by an earlier product version, including ones
     * naming a permission that no longer exists.
     */
    action: text("action").notNull(),

    /**
     * Who, denormalized — and that is deliberate.
     *
     * `actorUserId` can become null: `removeUser` exists, and deleting an
     * account must not erase the trace of what they did. An audit log that
     * disappears with its author is useless, yet that is exactly what a simple
     * cascading foreign key would have produced. The address is therefore
     * COPIED at write time; it stays readable when the `user` row is gone.
     */
    actorEmail: text("actor_email").notNull(),
    actorUserId: text("actor_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt,
    id: uuid("id").primaryKey().defaultRandom(),

    /** Where the request came from. Null if the runtime does not expose it. */
    ipAddress: text("ip_address"),
    outcome: auditOutcome("outcome").notNull(),
    resource: text("resource").notNull(),

    /** The role AT THE TIME OF THE FACTS, not today's. Without it, a
     *  demotion would rewrite the meaning of the entire history. */
    role: text("role"),
    userAgent: text("user_agent"),
  },
  (t) => [
    // Reads are always "most recent first".
    index("audit_log_created_idx").on(t.createdAt),
    index("audit_log_actor_idx").on(t.actorUserId),
  ]
);
