import { pgEnum, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
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
