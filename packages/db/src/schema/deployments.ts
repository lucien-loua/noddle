import {
  bigint,
  boolean,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt } from "#schema/columns";
import { services } from "#schema/services";

export const deploymentStatus = pgEnum("deployment_status", [
  "queued",
  "building",
  "deploying",
  // Converges and serves traffic. Post-deployment monitoring is still running.
  "succeeded",
  "failed",
  // Swarm refused the switchover: the health gate kicked in, the old version is serving.
  "rolled_back",
  // Converged THEN started restart-looping after the monitor window.
  // Distinct from `failed`: here the deployment had succeeded, and it's
  // Noddle that took back control. See CLAUDE.md, measured in Phase 0.
  "reverted_by_watch",
]);

export const deploymentTrigger = pgEnum("deployment_trigger", [
  "manual",
  "webhook",
  "rollback",
  "watch_revert",
]);

export const deployments = pgTable(
  "deployments",
  {
    commitSha: text("commit_sha"),

    createdAt,

    errorMessage: text("error_message"),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    id: uuid("id").primaryKey().defaultRandom(),

    // The image for this deployment has been removed from the registry by
    // retention.
    //
    // The history row STAYS — knowing which commit ran when shouldn't
    // disappear just because we reclaimed disk space. But its image no
    // longer exists, and offering "Replay this version" would send the
    // user toward a certain failure. Without this column, the dashboard
    // would offer an action it already knows is impossible.
    imagePurged: boolean("image_purged").notNull().default(false),

    // The exact tag built and deployed. This is THE column that makes
    // rollback possible to any version, not just the previous one.
    imageTag: text("image_tag"),

    // The Swarm node the task is ACTUALLY running on, recorded after
    // convergence — not the one we requested.
    //
    // As long as every image was local to its node, the question didn't
    // arise: `services.server_id` was both where it was built and where it
    // ran. With a registry, the image is portable and it's the Swarm
    // scheduler that chooses. `server_id` therefore no longer means
    // anything more than "where it's built", and a dashboard that kept
    // showing it as the execution location would be asserting something
    // false.
    //
    // NULL for any deployment from before the registry, and for any
    // deployment with no task running: a gap stays a gap, it isn't filled
    // in with the build server "by default".
    nodeId: text("node_id"),

    serviceId: uuid("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),

    startedAt: timestamp("started_at", { withTimezone: true }),

    status: deploymentStatus("status").notNull().default("queued"),

    // `docker service update` returns 0 even after a rollback: the real
    // state can only be read from UpdateStatus.State. We store it as-is
    // rather than deriving it from an exit code.
    swarmUpdateState: text("swarm_update_state"),
    trigger: deploymentTrigger("trigger").notNull().default("manual"),

    // Until when post-deployment monitoring watches the service. Swarm's
    // guarantee expires with --update-monitor; this one takes over.
    watchUntil: timestamp("watch_until", { withTimezone: true }),
  },
  (t) => [index("deployments_service_created_idx").on(t.serviceId, t.createdAt)]
);

// ─────────────────────────────────────────────────────────────────────────────
// deployment_logs — POINTER, never the text
// ─────────────────────────────────────────────────────────────────────────────

export const deploymentLogs = pgTable(
  "deployment_logs",
  {
    byteSize: bigint("byte_size", { mode: "number" }).notNull().default(0),

    createdAt,
    deploymentId: uuid("deployment_id")
      .notNull()
      .references(() => deployments.id, { onDelete: "cascade" }),
    id: uuid("id").primaryKey().defaultRandom(),

    // Disk path or object URL. Log text is sent over SSE to the dashboard
    // and persisted alongside it. NEVER one Postgres row per log line: a
    // Next.js build produces tens of thousands of them.
    storageUrl: text("storage_url").notNull(),
  },
  (t) => [index("deployment_logs_deployment_idx").on(t.deploymentId)]
);
