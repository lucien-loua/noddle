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

export const gitProviders = pgTable(
  "git_providers",
  {
    createdAt,
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    providerType: gitProviderType("provider_type").notNull(),
    updatedAt,
  },
  (t) => [uniqueIndex("git_providers_name_idx").on(t.name)]
);

export const githubProviders = pgTable("github_providers", {
  appId: text("app_id"),
  appName: text("app_name"),
  clientId: text("client_id"),
  clientSecretEncrypted: text("client_secret_encrypted"),
  createdAt,
  gitProviderId: uuid("git_provider_id")
    .primaryKey()
    .references(() => gitProviders.id, { onDelete: "cascade" }),
  htmlUrl: text("html_url"),
  installationId: text("installation_id"),
  privateKeyEncrypted: text("private_key_encrypted"),
  updatedAt,
  url: text("url").notNull().default("https://github.com"),
  webhookSecretEncrypted: text("webhook_secret_encrypted"),
});

export const gitlabProviders = pgTable("gitlab_providers", {
  accessTokenEncrypted: text("access_token_encrypted"),
  applicationId: text("application_id"),
  createdAt,
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  gitProviderId: uuid("git_provider_id")
    .primaryKey()
    .references(() => gitProviders.id, { onDelete: "cascade" }),
  groupName: text("group_name"),
  redirectUri: text("redirect_uri"),
  refreshTokenEncrypted: text("refresh_token_encrypted"),
  secretEncrypted: text("secret_encrypted"),
  updatedAt,
  url: text("url").notNull().default("https://gitlab.com"),
  webhookSecretEncrypted: text("webhook_secret_encrypted"),
});

export const gitlabRepositoryHooks = pgTable(
  "gitlab_repository_hooks",
  {
    createdAt,
    gitProviderId: uuid("git_provider_id")
      .notNull()
      .references(() => gitProviders.id, { onDelete: "cascade" }),
    hookId: text("hook_id"),
    hookUrl: text("hook_url").notNull(),
    id: uuid("id").primaryKey().defaultRandom(),
    lastError: text("last_error"),
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
