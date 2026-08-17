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

    // The currently served deployment — same role as
    // `services.currentDeploymentId`: allows rollback to any version in
    // the history, not just the previous one.
    currentDeploymentId: uuid("current_deployment_id"),
    domain: text("domain"),
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    gitBranch: text("git_branch").notNull().default("main"),
    gitRepoUrl: text("git_repo_url").notNull(),
    id: uuid("id").primaryKey().defaultRandom(),

    // Why a teardown failed — same reasoning as `services.lastError`.
    lastError: text("last_error"),
    name: text("name").notNull(),
    port: integer("port"),

    // The key of the service, WITHIN the compose file, that receives the
    // Traefik route. Absent = stack with no public surface (a pure queue,
    // for example): legitimate, not missing data.
    publicService: text("public_service"),

    // Like `services.serverId`: the link is structural, not a simple
    // placement — Swarm cannot move an image that only exists on the node
    // that built it.
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "restrict" }),
    status: serviceStatus("status").notNull().default("created"),

    // The Swarm namespace, WRITTEN at creation and never recomputed.
    //
    // `name` is unique per environment, Swarm is global: two `web` stacks
    // would designate the same namespace. We can't get away with
    // recomputing it, the way `swarmServiceName()` does for a service: a
    // stack prefixes its volumes (measured: `volstack_data`), so renaming
    // it would orphan its data — the stack would restart on an EMPTY
    // volume, with no error. Rows from before this fix are therefore
    // backfilled to their current name and never move again. See
    // `@noddle/shared/swarm-names`.
    swarmName: text("swarm_name").notNull(),
    updatedAt,

    // Same principle as `services.webhookSecretEncrypted`: absent = no
    // webhook, and never read back in plaintext after it's generated.
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

    // The YAML as read from the repository, BEFORE `build:` entries are
    // rewritten to `image:`. A rollback replays THIS text version with the
    // tags already recorded — no network access to either the git repo or
    // a new build, exactly the principle that makes `redeployImage`
    // instant.
    composeSource: text("compose_source"),

    createdAt,
    errorMessage: text("error_message"),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    id: uuid("id").primaryKey().defaultRandom(),

    // One tag per compose service that NODDLE built (those with `build:`).
    // Services that only have `image:` don't appear here: nothing to
    // replay, they always point to the same external image.
    serviceImages: jsonb("service_images").$type<Record<string, string>>(),

    stackId: uuid("stack_id")
      .notNull()
      .references(() => stacks.id, { onDelete: "cascade" }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    status: deploymentStatus("status").notNull().default("queued"),

    // One state per resulting Swarm service, never a single aggregate:
    // `docker stack deploy` returns before convergence, exactly like
    // `docker service update` — the same caution about the exit code
    // applies, multiplied by the number of containers in the stack.
    swarmUpdateStates: jsonb("swarm_update_states").$type<
      Record<string, string | null>
    >(),
    trigger: deploymentTrigger("trigger").notNull().default("manual"),

    // Like `deployments.watchUntil`: Swarm's guarantee expires with its
    // monitor window, Noddle's monitoring takes over.
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

    // Disk path or object URL, never one Postgres row per log line — same
    // reasoning as `deploymentLogs`.
    storageUrl: text("storage_url").notNull(),
  },
  (t) => [index("stack_deployment_logs_deployment_idx").on(t.stackDeploymentId)]
);
