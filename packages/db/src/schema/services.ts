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
import { environments } from "#schema/projects";
import { registries } from "#schema/registries";
import { servers } from "#schema/servers";

export const sourceType = pgEnum("source_type", [
  "git",
  "github",
  "gitlab",
  "docker_image",
  "compose",
]);

export const buildMethod = pgEnum("build_method", [
  "nixpacks",
  "dockerfile",
  "image",
]);

export const serviceStatus = pgEnum("service_status", [
  "created",
  "deploying",
  "running",
  "stopped",
  "crashed",
  // Teardown is in progress: the Swarm service must disappear BEFORE the
  // row, otherwise Traefik would keep routing to an application the user
  // believes has been deleted — a lie worse than the reverse.
  //
  // A service that stays here is a teardown that failed, not a stable
  // state. The action is replayable: `removeService` and the registry
  // purge are idempotent.
  "deleting",
]);

export const services = pgTable(
  "services",
  {
    // Off keeps the webhook secret intact — the hook stays configured on the
    // provider's side, it just stops deploying.
    autoDeploy: boolean("auto_deploy").notNull().default(true),

    buildMethod: buildMethod("build_method").notNull().default("nixpacks"),

    /** Build context inside the repo. `null` = repository root. */
    buildPath: text("build_path"),

    /** `--no-cache` on every build while on. */
    cleanCache: boolean("clean_cache").notNull().default(false),

    createdAt,

    // Currently served deployment. Used for rollback: Noddle replays an
    // image from ITS OWN history, whereas Swarm only keeps one previous
    // spec.
    currentDeploymentId: uuid("current_deployment_id"),
    /**
     * Published image when `sourceType` is `docker_image`. Unused on git
     * sources — kept if the user switches back, rather than destroyed.
     */
    dockerImage: text("docker_image"),
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    gitBranch: text("git_branch"),
    gitRepoUrl: text("git_repo_url"),

    /** `--recurse-submodules` on clone. */
    gitSubmodules: boolean("git_submodules").notNull().default(false),

    id: uuid("id").primaryKey().defaultRandom(),

    // Why a teardown failed, visible without digging through the worker's
    // logs — same reasoning as `servers.last_error`. `status` alone says
    // WHAT (`deleting`), not WHY it didn't converge. `null` as long as
    // nothing has failed; never cleared automatically, to stay legible if
    // the service remains stuck.
    lastError: text("last_error"),
    name: text("name").notNull(),
    port: integer("port").notNull().default(3000),

    /**
     * A pull request preview is an ORDINARY service, not a separate table:
     * it builds, deploys, has logs, a history, a rollback, metrics and
     * post-deployment monitoring. Everything `services` already carries.
     * A dedicated table would duplicate half the worker.
     *
     * What distinguishes it comes down to two columns: WHO it's a preview
     * of, and which PR. `null` on an ordinary service.
     *
     * The cascade is intentional: deleting a service takes its previews
     * with it, which have no meaning without it.
     */
    previewOfServiceId: uuid("preview_of_service_id").references(
      (): AnyPgColumn => services.id,
      { onDelete: "cascade" }
    ),
    prNumber: integer("pr_number"),

    /**
     * Relative path to static build output (e.g. `dist`, `build`). When set,
     * Nixpacks serves that folder as a static site via `NIXPACKS_SPA_OUT_DIR`.
     * `null` = run the detected server process instead.
     */
    publishDirectory: text("publish_directory"),

    // `null` = the embedded registry, the one from the installation. Same
    // shape as `databases.s3_destination_id`: as long as no external
    // registry exists, nothing ever asks you to choose one. `restrict`
    // because deleting a registry still in use would make its images
    // unpullable without any warning.
    registryId: uuid("registry_id").references(() => registries.id, {
      onDelete: "restrict",
    }),

    // Locally built images only exist on the machine that produced them:
    // Swarm cannot move the service elsewhere. The link to the server is
    // therefore structural, not a simple placement.
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "restrict" }),
    sourceType: sourceType("source_type").notNull(),
    status: serviceStatus("status").notNull().default("created"),
    updatedAt,

    /** Globs a webhook push must touch to deploy. Empty = every push does. */
    watchPaths: text("watch_paths").array().notNull().default(sql`'{}'`),

    // Absent = no webhook configured. Shown once in plaintext, at the
    // moment it's generated — never read back afterward, even encrypted:
    // the form can only regenerate it, exactly like an API token.
    webhookSecretEncrypted: text("webhook_secret_encrypted"),
  },
  (t) => [
    uniqueIndex("services_env_name_idx").on(t.environmentId, t.name),
    index("services_server_idx").on(t.serverId),
    // ONE preview per PR and per parent service. A `synchronize` event (a
    // PR being updated) must FIND the existing preview and redeploy it,
    // never create a second one — otherwise every push to a PR branch
    // would leave behind one more service.
    uniqueIndex("services_preview_pr_idx")
      .on(t.previewOfServiceId, t.prNumber)
      .where(sql`${t.previewOfServiceId} is not null`),
  ]
);
