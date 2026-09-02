import {
  bigint,
  index,
  integer,
  jsonb,
  pgEnum,
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

export interface DatabaseExtraMount {
  id: string;
  source: string;
  target: string;
  type: "bind" | "volume";
}

export interface DatabaseSwarmSettings {
  endpointSpec?: {
    Mode?: "dnsrr" | "vip";
  } | null;
  healthCheck?: {
    Interval?: number | null;
    Retries?: number | null;
    StartPeriod?: number | null;
    Test?: string[] | null;
    Timeout?: number | null;
  } | null;
  labels?: Record<string, string> | null;
  mode?: {
    Global?: Record<string, never>;
    Replicated?: { Replicas?: number };
  } | null;
  networks?: { Aliases?: string[]; Target: string }[] | null;
  placement?: {
    Constraints?: string[];
    MaxReplicas?: number;
    Preferences?: { Spread: { SpreadDescriptor: string } }[];
  } | null;
  restartPolicy?: {
    Condition?: "any" | "none" | "on-failure";
    Delay?: number | null;
    MaxAttempts?: number | null;
    Window?: number | null;
  } | null;
  rollbackConfig?: {
    Delay?: number | null;
    FailureAction?: "continue" | "pause";
    MaxFailureRatio?: number | null;
    Monitor?: number | null;
    Order?: "start-first" | "stop-first";
    Parallelism?: number | null;
  } | null;
  stopGracePeriod?: number | null;
  updateConfig?: {
    Delay?: number | null;
    FailureAction?: "continue" | "pause" | "rollback";
    MaxFailureRatio?: number | null;
    Monitor?: number | null;
    Order?: "start-first" | "stop-first";
    Parallelism?: number | null;
  } | null;
}

export const databaseEngine = pgEnum("database_engine", [
  "postgres",
  "mysql",
  "mariadb",
  "mongo",
  "redis",
]);

export const databases = pgTable(
  "databases",
  {
    cpuLimitNanos: bigint("cpu_limit_nanos", { mode: "number" }),

    cpuReservationNanos: bigint("cpu_reservation_nanos", { mode: "number" }),
    createdAt,

    databaseName: text("database_name"),

    description: text("description"),
    engine: databaseEngine("engine").notNull(),
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),

    externalPort: integer("external_port"),

    extraMounts: jsonb("extra_mounts")
      .$type<DatabaseExtraMount[]>()
      .notNull()
      .default([]),
    id: uuid("id").primaryKey().defaultRandom(),

    image: text("image"),

    lastError: text("last_error"),

    memoryLimitBytes: bigint("memory_limit_bytes", { mode: "number" }),

    memoryReservationBytes: bigint("memory_reservation_bytes", {
      mode: "number",
    }),

    name: text("name").notNull(),

    displayName: text("display_name"),

    replicas: integer("replicas").notNull().default(1),

    rootPasswordEncrypted: text("root_password_encrypted").notNull(),

    rootUser: text("root_user"),

    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "restrict" }),
    status: serviceStatus("status").notNull().default("created"),

    swarmName: text("swarm_name").notNull(),

    swarmSettings: jsonb("swarm_settings").$type<DatabaseSwarmSettings>(),

    updatedAt,

    volumePath: text("volume_path"),
  },
  (t) => [uniqueIndex("databases_env_name_idx").on(t.environmentId, t.name)]
);

export const databaseDeployments = pgTable(
  "database_deployments",
  {
    createdAt,
    databaseId: uuid("database_id")
      .notNull()
      .references(() => databases.id, { onDelete: "cascade" }),
    errorMessage: text("error_message"),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    id: uuid("id").primaryKey().defaultRandom(),

    image: text("image"),

    startedAt: timestamp("started_at", { withTimezone: true }),
    status: deploymentStatus("status").notNull().default("queued"),

    swarmUpdateState: text("swarm_update_state"),
    trigger: deploymentTrigger("trigger").notNull().default("manual"),
  },
  (t) => [
    index("database_deployments_database_created_idx").on(
      t.databaseId,
      t.createdAt
    ),
  ]
);

export const databaseDeploymentLogs = pgTable(
  "database_deployment_logs",
  {
    byteSize: bigint("byte_size", { mode: "number" }).notNull().default(0),
    createdAt,
    databaseDeploymentId: uuid("database_deployment_id")
      .notNull()
      .references(() => databaseDeployments.id, { onDelete: "cascade" }),
    id: uuid("id").primaryKey().defaultRandom(),

    storageUrl: text("storage_url").notNull(),
  },
  (t) => [
    index("database_deployment_logs_deployment_idx").on(t.databaseDeploymentId),
  ]
);
