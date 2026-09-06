import { secretContext } from "@noddle/crypto";
import type { SecretContext } from "@noddle/crypto";

export interface EncryptedColumn {
  column: string;
  context: (id: string) => SecretContext;
  id: string;
  table: string;
}

export const ENCRYPTED_COLUMNS: EncryptedColumn[] = [
  {
    column: "private_key_encrypted",
    context: secretContext.sshKey,
    id: "id",
    table: "ssh_keys",
  },
  {
    column: "value_encrypted",
    context: secretContext.envVar,
    id: "id",
    table: "env_vars",
  },
  {
    column: "secret_access_key_encrypted",
    context: secretContext.backupDestination,
    id: "id",
    table: "s3_destinations",
  },
  {
    column: "root_password_encrypted",
    context: secretContext.databasePassword,
    id: "id",
    table: "databases",
  },
  {
    column: "url_encrypted",
    context: secretContext.notificationChannel,
    id: "id",
    table: "notification_channels",
  },
  {
    column: "password_encrypted",
    context: secretContext.registry,
    id: "id",
    table: "registries",
  },
  {
    column: "webhook_secret_encrypted",
    context: secretContext.webhookSecret,
    id: "id",
    table: "services",
  },
  {
    column: "webhook_secret_encrypted",
    context: secretContext.webhookSecret,
    id: "id",
    table: "stacks",
  },
  {
    column: "client_secret_encrypted",
    context: (id) => secretContext.gitProvider(id, "client_secret"),
    id: "git_provider_id",
    table: "github_providers",
  },
  {
    column: "private_key_encrypted",
    context: (id) => secretContext.gitProvider(id, "private_key"),
    id: "git_provider_id",
    table: "github_providers",
  },
  {
    column: "webhook_secret_encrypted",
    context: (id) => secretContext.gitProvider(id, "webhook_secret"),
    id: "git_provider_id",
    table: "github_providers",
  },
  {
    column: "access_token_encrypted",
    context: (id) => secretContext.gitProvider(id, "access_token"),
    id: "git_provider_id",
    table: "gitlab_providers",
  },
  {
    column: "refresh_token_encrypted",
    context: (id) => secretContext.gitProvider(id, "refresh_token"),
    id: "git_provider_id",
    table: "gitlab_providers",
  },
  {
    column: "secret_encrypted",
    context: (id) => secretContext.gitProvider(id, "client_secret"),
    id: "git_provider_id",
    table: "gitlab_providers",
  },
  {
    column: "webhook_secret_encrypted",
    context: (id) => secretContext.gitProvider(id, "webhook_secret"),
    id: "git_provider_id",
    table: "gitlab_providers",
  },
];
