import {
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, updatedAt } from "#schema/columns";

export const gitProviderType = pgEnum("git_provider_type", [
  "github",
  "gitlab",
]);

/**
 * A connected source forge. Carries a name and a type, and NOTHING else:
 * the two credential models have nothing in common, so each lives in its
 * own table joined one-to-one. See ADR-0019.
 */
export const gitProviders = pgTable(
  "git_providers",
  {
    createdAt,
    id: uuid("id").primaryKey().defaultRandom(),
    // What distinguishes two connections at a glance in the selector.
    name: text("name").notNull(),
    providerType: gitProviderType("provider_type").notNull(),
    updatedAt,
  },
  (t) => [uniqueIndex("git_providers_name_idx").on(t.name)]
);

/**
 * A GitHub App the OPERATOR created from their own instance, never one
 * Noddle ships (ADR-0019).
 *
 * `installationId` is null between creating the App and installing it —
 * two distinct steps on GitHub's side, and the row has to survive the gap
 * or the manifest exchange would be lost.
 */
export const githubProviders = pgTable("github_providers", {
  appId: text("app_id"),
  appName: text("app_name"),
  clientId: text("client_id"),
  clientSecretEncrypted: text("client_secret_encrypted"),
  createdAt,
  gitProviderId: uuid("git_provider_id")
    .primaryKey()
    .references(() => gitProviders.id, { onDelete: "cascade" }),
  /** The App's page. `installUrl` derives the install link from it. */
  htmlUrl: text("html_url"),
  /** Set once the App is installed on an account. */
  installationId: text("installation_id"),
  privateKeyEncrypted: text("private_key_encrypted"),
  updatedAt,
  /** `https://github.com`, or a GitHub Enterprise host. */
  url: text("url").notNull().default("https://github.com"),
  webhookSecretEncrypted: text("webhook_secret_encrypted"),
});

/**
 * A GitLab OAuth application, per ADR-0019.
 *
 * Unlike a GitHub App this holds a token that EXPIRES, so `expiresAt` is a
 * column and not a detail: it is refreshed before use with a margin, never
 * lazily on a 401 — a 401 surfaces as a failed deploy, minutes into a build.
 *
 * Do not "harmonise" this with `github_providers`. The asymmetry is the
 * platform's, not a design we chose.
 */
export const gitlabProviders = pgTable("gitlab_providers", {
  accessTokenEncrypted: text("access_token_encrypted"),
  applicationId: text("application_id"),
  createdAt,
  /** When the access token dies. `null` until the first exchange. */
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  gitProviderId: uuid("git_provider_id")
    .primaryKey()
    .references(() => gitProviders.id, { onDelete: "cascade" }),
  /** Scopes the repository listing when set. */
  groupName: text("group_name"),
  redirectUri: text("redirect_uri"),
  refreshTokenEncrypted: text("refresh_token_encrypted"),
  secretEncrypted: text("secret_encrypted"),
  updatedAt,
  /** `https://gitlab.com`, or a self-hosted instance. */
  url: text("url").notNull().default("https://gitlab.com"),
  webhookSecretEncrypted: text("webhook_secret_encrypted"),
});

/**
 * A Repository hook. GitLab only: a GitHub App carries one hook for the whole
 * App, so there is nothing per-repository to record there.
 *
 * Keyed on connection + repository, not Service — several Services can deploy
 * one repository and share the hook.
 */
export const gitlabRepositoryHooks = pgTable(
  "gitlab_repository_hooks",
  {
    createdAt,
    gitProviderId: uuid("git_provider_id")
      .notNull()
      .references(() => gitProviders.id, { onDelete: "cascade" }),
    /** Null with `lastError` set = registration failed, Maintainer+ needed. */
    hookId: text("hook_id"),
    /**
     * Where the hook points. Stored because the worker's reconcile sweep has
     * no notion of the dashboard's public origin — web writes it, the sweep
     * reuses it.
     */
    hookUrl: text("hook_url").notNull(),
    id: uuid("id").primaryKey().defaultRandom(),
    lastError: text("last_error"),
    /** Matches `path_with_namespace`. */
    repositoryFullName: text("repository_full_name").notNull(),
    updatedAt,
  },
  (t) => [
    uniqueIndex("gitlab_repository_hooks_idx").on(
      t.gitProviderId,
      t.repositoryFullName
    ),
  ]
);
