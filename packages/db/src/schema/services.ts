import { sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { createdAt, updatedAt } from "#schema/columns";
import { gitProviders } from "#schema/git-providers";
import { environments } from "#schema/projects";
import { registries } from "#schema/registries";
import { servers } from "#schema/servers";
import { sshKeys } from "#schema/ssh-keys";

export const sourceType = pgEnum("source_type", [
  "git",
  "github",
  "gitlab",
  "docker_image",
  "compose",
]);

export const buildMethod = pgEnum("build_method", [
  "railpack",
  "dockerfile",
  "image",
]);

export const serviceStatus = pgEnum("service_status", [
  "created",
  "deploying",
  "running",
  "stopped",
  "crashed",
  "deleting",
]);

export const services = pgTable(
  "services",
  {
    autoDeploy: boolean("auto_deploy").notNull().default(true),

    buildMethod: buildMethod("build_method").notNull().default("railpack"),

    buildPath: text("build_path"),

    cleanCache: boolean("clean_cache").notNull().default(false),

    createdAt,

    currentDeploymentId: uuid("current_deployment_id"),

    deployKeyId: uuid("deploy_key_id").references(() => sshKeys.id, {
      onDelete: "restrict",
    }),
    dockerImage: text("docker_image"),
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    gitBranch: text("git_branch"),

    gitProviderId: uuid("git_provider_id").references(() => gitProviders.id, {
      onDelete: "set null",
    }),
    gitRepoFullName: text("git_repo_full_name"),
    gitRepoUrl: text("git_repo_url"),

    gitSubmodules: boolean("git_submodules").notNull().default(false),

    id: uuid("id").primaryKey().defaultRandom(),

    lastError: text("last_error"),
    name: text("name").notNull(),
    port: integer("port").notNull().default(3000),

    displayName: text("display_name"),

    previewOfServiceId: uuid("preview_of_service_id").references(
      (): AnyPgColumn => services.id,
      {
        onDelete: "cascade",
      }
    ),
    prNumber: integer("pr_number"),

    publishDirectory: text("publish_directory"),

    registryId: uuid("registry_id").references(() => registries.id, {
      onDelete: "restrict",
    }),

    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "restrict" }),
    sourceType: sourceType("source_type").notNull(),
    status: serviceStatus("status").notNull().default("created"),
    updatedAt,

    watchPaths: text("watch_paths")
      .array()
      .notNull()
      .default(sql`'{}'`),

    webhookSecretEncrypted: text("webhook_secret_encrypted"),
  },
  (t) => [
    uniqueIndex("services_env_name_idx").on(t.environmentId, t.name),
    index("services_server_idx").on(t.serverId),
    uniqueIndex("services_preview_pr_idx")
      .on(t.previewOfServiceId, t.prNumber)
      .where(sql`${t.previewOfServiceId} is not null`),
  ]
);
