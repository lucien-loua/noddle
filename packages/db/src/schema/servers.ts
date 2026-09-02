import {
  boolean,
  integer,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { createdAt, updatedAt } from "#schema/columns";
import { sshKeys } from "#schema/ssh-keys";

export const serverStatus = pgEnum("server_status", [
  "pending",
  "connected",
  "unreachable",
]);

export const serverRole = pgEnum("server_role", ["manager", "worker"]);

export const controlPlaneStatus = pgEnum("control_plane_status", [
  "idle",
  "applying",
  "failed",
]);

export const servers = pgTable(
  "servers",
  {
    createdAt,

    dockerApiMinVersion: text("docker_api_min_version"),
    dockerVersion: text("docker_version"),
    host: text("host").notNull(),
    id: uuid("id").primaryKey().defaultRandom(),

    isSelf: boolean("is_self").notNull().default(false),

    lastError: text("last_error"),
    name: text("name").notNull(),

    pruneEnabled: boolean("prune_enabled").notNull().default(true),

    role: serverRole("role").notNull().default("worker"),

    sshKeyId: uuid("ssh_key_id")
      .notNull()
      .references(() => sshKeys.id, { onDelete: "restrict" }),
    sshPort: integer("ssh_port").notNull().default(22),
    sshUser: text("ssh_user").notNull(),

    status: serverStatus("status").notNull().default("pending"),

    swarmNodeId: text("swarm_node_id"),

    totalMemoryMb: integer("total_memory_mb"),
    updatedAt,
  },
  (t) => [
    uniqueIndex("servers_host_port_user_idx").on(t.host, t.sshPort, t.sshUser),
  ]
);

export const controlPlaneSettings = pgTable("control_plane_settings", {
  acmeEmail: text("acme_email"),
  createdAt,
  domain: text("domain"),
  httpsEnabled: boolean("https_enabled").notNull().default(false),
  id: uuid("id").primaryKey().defaultRandom(),
  lastError: text("last_error"),
  status: controlPlaneStatus("status").notNull().default("idle"),
  updatedAt,
});
