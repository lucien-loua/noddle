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
  "succeeded",
  "failed",
  "rolled_back",
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

    imagePurged: boolean("image_purged").notNull().default(false),

    imageTag: text("image_tag"),

    nodeId: text("node_id"),

    serviceId: uuid("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),

    startedAt: timestamp("started_at", { withTimezone: true }),

    status: deploymentStatus("status").notNull().default("queued"),

    swarmUpdateState: text("swarm_update_state"),
    trigger: deploymentTrigger("trigger").notNull().default("manual"),

    watchUntil: timestamp("watch_until", { withTimezone: true }),
  },
  (t) => [index("deployments_service_created_idx").on(t.serviceId, t.createdAt)]
);

export const deploymentLogs = pgTable(
  "deployment_logs",
  {
    byteSize: bigint("byte_size", { mode: "number" }).notNull().default(0),

    createdAt,
    deploymentId: uuid("deployment_id")
      .notNull()
      .references(() => deployments.id, { onDelete: "cascade" }),
    id: uuid("id").primaryKey().defaultRandom(),

    storageUrl: text("storage_url").notNull(),
  },
  (t) => [index("deployment_logs_deployment_idx").on(t.deploymentId)]
);
