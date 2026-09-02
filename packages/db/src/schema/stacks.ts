import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { createdAt, updatedAt } from "#schema/columns";
import { deploymentStatus, deploymentTrigger } from "#schema/deployments";
import { environments } from "#schema/projects";
import { servers } from "#schema/servers";
import { serviceStatus } from "#schema/services";

export const stacks = pgTable(
  "stacks",
  {
    composeFilePath: text("compose_file_path")
      .notNull()
      .default("docker-compose.yml"),
    createdAt,

    currentDeploymentId: uuid("current_deployment_id"),
    domain: text("domain"),
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    gitBranch: text("git_branch").notNull().default("main"),
    gitRepoUrl: text("git_repo_url").notNull(),
    id: uuid("id").primaryKey().defaultRandom(),

    lastError: text("last_error"),
    name: text("name").notNull(),

    displayName: text("display_name"),
    port: integer("port"),

    publicService: text("public_service"),

    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "restrict" }),
    status: serviceStatus("status").notNull().default("created"),

    swarmName: text("swarm_name").notNull(),
    updatedAt,

    webhookSecretEncrypted: text("webhook_secret_encrypted"),
  },
  (t) => [
    uniqueIndex("stacks_env_name_idx").on(t.environmentId, t.name),
    index("stacks_server_idx").on(t.serverId),
  ]
);

export const stackDeployments = pgTable(
  "stack_deployments",
  {
    commitSha: text("commit_sha"),

    composeSource: text("compose_source"),

    createdAt,
    errorMessage: text("error_message"),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    id: uuid("id").primaryKey().defaultRandom(),

    serviceImages: jsonb("service_images").$type<Record<string, string>>(),

    stackId: uuid("stack_id")
      .notNull()
      .references(() => stacks.id, { onDelete: "cascade" }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    status: deploymentStatus("status").notNull().default("queued"),

    swarmUpdateStates: jsonb("swarm_update_states").$type<
      Record<string, string | null>
    >(),
    trigger: deploymentTrigger("trigger").notNull().default("manual"),

    watchUntil: timestamp("watch_until", { withTimezone: true }),
  },
  (t) => [
    index("stack_deployments_stack_created_idx").on(t.stackId, t.createdAt),
  ]
);

export const stackDeploymentLogs = pgTable(
  "stack_deployment_logs",
  {
    byteSize: bigint("byte_size", { mode: "number" }).notNull().default(0),
    createdAt,
    id: uuid("id").primaryKey().defaultRandom(),
    stackDeploymentId: uuid("stack_deployment_id")
      .notNull()
      .references(() => stackDeployments.id, { onDelete: "cascade" }),

    storageUrl: text("storage_url").notNull(),
  },
  (t) => [index("stack_deployment_logs_deployment_idx").on(t.stackDeploymentId)]
);
