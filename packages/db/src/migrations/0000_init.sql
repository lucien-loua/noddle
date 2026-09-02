CREATE TYPE "public"."audit_outcome" AS ENUM('allowed', 'denied');--> statement-breakpoint
CREATE TYPE "public"."backup_kind" AS ENUM('manual', 'scheduled', 'pre_restore');--> statement-breakpoint
CREATE TYPE "public"."backup_status" AS ENUM('queued', 'running', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."database_engine" AS ENUM('postgres', 'mysql', 'mariadb', 'mongo', 'redis');--> statement-breakpoint
CREATE TYPE "public"."deployment_status" AS ENUM('queued', 'building', 'deploying', 'succeeded', 'failed', 'rolled_back', 'reverted_by_watch');--> statement-breakpoint
CREATE TYPE "public"."deployment_trigger" AS ENUM('manual', 'webhook', 'rollback', 'watch_revert');--> statement-breakpoint
CREATE TYPE "public"."git_provider_type" AS ENUM('github', 'gitlab');--> statement-breakpoint
CREATE TYPE "public"."notification_kind" AS ENUM('webhook', 'discord', 'slack');--> statement-breakpoint
CREATE TYPE "public"."server_role" AS ENUM('manager', 'worker');--> statement-breakpoint
CREATE TYPE "public"."server_status" AS ENUM('pending', 'connected', 'unreachable');--> statement-breakpoint
CREATE TYPE "public"."certificate_type" AS ENUM('none', 'letsencrypt');--> statement-breakpoint
CREATE TYPE "public"."build_method" AS ENUM('railpack', 'dockerfile', 'image');--> statement-breakpoint
CREATE TYPE "public"."service_status" AS ENUM('created', 'deploying', 'running', 'stopped', 'crashed', 'deleting');--> statement-breakpoint
CREATE TYPE "public"."source_type" AS ENUM('git', 'github', 'gitlab', 'docker_image', 'compose');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"action" text NOT NULL,
	"actor_email" text NOT NULL,
	"actor_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ip_address" text,
	"outcome" "audit_outcome" NOT NULL,
	"resource" text NOT NULL,
	"resource_id" text,
	"resource_name" text,
	"role" text,
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE "account" (
	"access_token" text,
	"access_token_expires_at" timestamp,
	"account_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"id_token" text,
	"password" text,
	"provider_id" text NOT NULL,
	"refresh_token" text,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"updated_at" timestamp NOT NULL,
	"user_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"impersonated_by" text,
	"ip_address" text,
	"token" text NOT NULL,
	"updated_at" timestamp NOT NULL,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"ban_expires" timestamp,
	"banned" boolean DEFAULT false,
	"ban_reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"image" text,
	"name" text NOT NULL,
	"role" text,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"value" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backup_configs" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"database_id" uuid NOT NULL,
	"database_name" text NOT NULL,
	"destination_id" uuid NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"keep_latest_count" integer,
	"prefix" text DEFAULT '' NOT NULL,
	"schedule" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backups" (
	"config_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"database_id" uuid NOT NULL,
	"destination_id" uuid,
	"error_message" text,
	"finished_at" timestamp with time zone,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "backup_kind" DEFAULT 'manual' NOT NULL,
	"object_key" text NOT NULL,
	"size_bytes" bigint DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"status" "backup_status" DEFAULT 'queued' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "databases" (
	"cpu_limit_nanos" bigint,
	"cpu_reservation_nanos" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"database_name" text,
	"description" text,
	"engine" "database_engine" NOT NULL,
	"environment_id" uuid NOT NULL,
	"external_port" integer,
	"extra_mounts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"image" text,
	"last_error" text,
	"memory_limit_bytes" bigint,
	"memory_reservation_bytes" bigint,
	"name" text NOT NULL,
	"display_name" text,
	"replicas" integer DEFAULT 1 NOT NULL,
	"root_password_encrypted" text NOT NULL,
	"root_user" text,
	"server_id" uuid NOT NULL,
	"status" "service_status" DEFAULT 'created' NOT NULL,
	"swarm_name" text NOT NULL,
	"swarm_settings" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"volume_path" text
);
--> statement-breakpoint
CREATE TABLE "deployment_logs" (
	"byte_size" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deployment_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"storage_url" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deployments" (
	"commit_sha" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"error_message" text,
	"finished_at" timestamp with time zone,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"image_purged" boolean DEFAULT false NOT NULL,
	"image_tag" text,
	"node_id" text,
	"service_id" uuid NOT NULL,
	"started_at" timestamp with time zone,
	"status" "deployment_status" DEFAULT 'queued' NOT NULL,
	"swarm_update_state" text,
	"trigger" "deployment_trigger" DEFAULT 'manual' NOT NULL,
	"watch_until" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "env_vars" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"database_id" uuid,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"is_secret" boolean DEFAULT false NOT NULL,
	"key" text NOT NULL,
	"service_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"value_encrypted" text NOT NULL,
	CONSTRAINT "env_vars_one_owner" CHECK (("env_vars"."service_id" is null) <> ("env_vars"."database_id" is null))
);
--> statement-breakpoint
CREATE TABLE "git_providers" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"provider_type" "git_provider_type" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_providers" (
	"app_id" text,
	"app_name" text,
	"client_id" text,
	"client_secret_encrypted" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"git_provider_id" uuid PRIMARY KEY NOT NULL,
	"html_url" text,
	"installation_id" text,
	"private_key_encrypted" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"url" text DEFAULT 'https://github.com' NOT NULL,
	"webhook_secret_encrypted" text
);
--> statement-breakpoint
CREATE TABLE "gitlab_providers" (
	"access_token_encrypted" text,
	"application_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"git_provider_id" uuid PRIMARY KEY NOT NULL,
	"group_name" text,
	"redirect_uri" text,
	"refresh_token_encrypted" text,
	"secret_encrypted" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"url" text DEFAULT 'https://gitlab.com' NOT NULL,
	"webhook_secret_encrypted" text
);
--> statement-breakpoint
CREATE TABLE "gitlab_repository_hooks" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"git_provider_id" uuid NOT NULL,
	"hook_id" text,
	"hook_url" text NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"last_error" text,
	"repository_full_name" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "server_disk_usage" (
	"build_cache_bytes" bigint NOT NULL,
	"build_cache_count" bigint NOT NULL,
	"build_cache_reclaimable_bytes" bigint NOT NULL,
	"container_bytes" bigint NOT NULL,
	"container_count" bigint NOT NULL,
	"container_reclaimable_bytes" bigint NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"image_bytes" bigint NOT NULL,
	"image_count" bigint NOT NULL,
	"image_reclaimable_bytes" bigint NOT NULL,
	"sampled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"server_id" uuid NOT NULL,
	"volume_bytes" bigint NOT NULL,
	"volume_count" bigint NOT NULL,
	"volume_reclaimable_bytes" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "server_metrics" (
	"block_read_bytes" bigint NOT NULL,
	"block_write_bytes" bigint NOT NULL,
	"cpu_count" bigint NOT NULL,
	"cpu_load1" real NOT NULL,
	"disk_total_bytes" bigint NOT NULL,
	"disk_used_bytes" bigint NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"memory_total_bytes" bigint NOT NULL,
	"memory_used_bytes" bigint NOT NULL,
	"network_in_bytes" bigint NOT NULL,
	"network_out_bytes" bigint NOT NULL,
	"sampled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"server_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_metrics" (
	"block_read_bytes" bigint NOT NULL,
	"block_write_bytes" bigint NOT NULL,
	"cpu_percent" real NOT NULL,
	"database_id" uuid,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"memory_limit_bytes" bigint NOT NULL,
	"memory_used_bytes" bigint NOT NULL,
	"network_in_bytes" bigint NOT NULL,
	"network_out_bytes" bigint NOT NULL,
	"sampled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"service_id" uuid,
	"task_name" text NOT NULL,
	CONSTRAINT "service_metrics_one_owner" CHECK (("service_metrics"."service_id" is null) <> ("service_metrics"."database_id" is null))
);
--> statement-breakpoint
CREATE TABLE "notification_channels" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "notification_kind" NOT NULL,
	"last_error" text,
	"last_success_at" timestamp with time zone,
	"name" text NOT NULL,
	"notify_success" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"url_encrypted" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "environments" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"description" text,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"name" text NOT NULL,
	"project_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"description" text,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "registries" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"image_prefix" text DEFAULT '' NOT NULL,
	"name" text NOT NULL,
	"password_encrypted" text NOT NULL,
	"registry_url" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"username" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "s3_destinations" (
	"access_key_id" text NOT NULL,
	"bucket" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"endpoint" text NOT NULL,
	"force_path_style" boolean DEFAULT true NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"prefix" text DEFAULT '' NOT NULL,
	"region" text DEFAULT 'us-east-1' NOT NULL,
	"secret_access_key_encrypted" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "servers" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"docker_api_min_version" text,
	"docker_version" text,
	"host" text NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"is_self" boolean DEFAULT false NOT NULL,
	"last_error" text,
	"name" text NOT NULL,
	"prune_enabled" boolean DEFAULT true NOT NULL,
	"role" "server_role" DEFAULT 'worker' NOT NULL,
	"ssh_key_id" uuid NOT NULL,
	"ssh_port" integer DEFAULT 22 NOT NULL,
	"ssh_user" text NOT NULL,
	"status" "server_status" DEFAULT 'pending' NOT NULL,
	"swarm_node_id" text,
	"total_memory_mb" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_dependencies" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"depends_on_database_id" uuid,
	"depends_on_service_id" uuid,
	"env_var_id" uuid,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_id" uuid NOT NULL,
	CONSTRAINT "service_dependencies_one_target" CHECK (("service_dependencies"."depends_on_service_id" is null) <> ("service_dependencies"."depends_on_database_id" is null)),
	CONSTRAINT "service_dependencies_no_self" CHECK ("service_dependencies"."depends_on_service_id" is distinct from "service_dependencies"."service_id")
);
--> statement-breakpoint
CREATE TABLE "service_domains" (
	"certificate_type" "certificate_type" DEFAULT 'none' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"host" text NOT NULL,
	"https" boolean DEFAULT false NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"internal_path" text,
	"path" text DEFAULT '/' NOT NULL,
	"service_id" uuid NOT NULL,
	"strip_path" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "services" (
	"auto_deploy" boolean DEFAULT true NOT NULL,
	"build_method" "build_method" DEFAULT 'railpack' NOT NULL,
	"build_path" text,
	"clean_cache" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"current_deployment_id" uuid,
	"deploy_key_id" uuid,
	"docker_image" text,
	"environment_id" uuid NOT NULL,
	"git_branch" text,
	"git_provider_id" uuid,
	"git_repo_full_name" text,
	"git_repo_url" text,
	"git_submodules" boolean DEFAULT false NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"last_error" text,
	"name" text NOT NULL,
	"port" integer DEFAULT 3000 NOT NULL,
	"display_name" text,
	"preview_of_service_id" uuid,
	"pr_number" integer,
	"publish_directory" text,
	"registry_id" uuid,
	"server_id" uuid NOT NULL,
	"source_type" "source_type" NOT NULL,
	"status" "service_status" DEFAULT 'created' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"watch_paths" text[] DEFAULT '{}' NOT NULL,
	"webhook_secret_encrypted" text
);
--> statement-breakpoint
CREATE TABLE "ssh_keys" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"private_key_encrypted" text NOT NULL,
	"public_key" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stack_deployment_logs" (
	"byte_size" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stack_deployment_id" uuid NOT NULL,
	"storage_url" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stack_deployments" (
	"commit_sha" text,
	"compose_source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"error_message" text,
	"finished_at" timestamp with time zone,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_images" jsonb,
	"stack_id" uuid NOT NULL,
	"started_at" timestamp with time zone,
	"status" "deployment_status" DEFAULT 'queued' NOT NULL,
	"swarm_update_states" jsonb,
	"trigger" "deployment_trigger" DEFAULT 'manual' NOT NULL,
	"watch_until" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "stacks" (
	"compose_file_path" text DEFAULT 'docker-compose.yml' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"current_deployment_id" uuid,
	"domain" text,
	"environment_id" uuid NOT NULL,
	"git_branch" text DEFAULT 'main' NOT NULL,
	"git_repo_url" text NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"last_error" text,
	"name" text NOT NULL,
	"display_name" text,
	"port" integer,
	"public_service" text,
	"server_id" uuid NOT NULL,
	"status" "service_status" DEFAULT 'created' NOT NULL,
	"swarm_name" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"webhook_secret_encrypted" text
);
--> statement-breakpoint
CREATE TABLE "volume_backup_configs" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"destination_id" uuid NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"keep_latest_count" integer,
	"mount_path" text,
	"prefix" text DEFAULT '' NOT NULL,
	"schedule" text NOT NULL,
	"service_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"volume_name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "volume_backups" (
	"config_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"destination_id" uuid,
	"error_message" text,
	"finished_at" timestamp with time zone,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "backup_kind" DEFAULT 'manual' NOT NULL,
	"object_key" text NOT NULL,
	"service_id" uuid NOT NULL,
	"size_bytes" bigint DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"status" "backup_status" DEFAULT 'queued' NOT NULL,
	"volume_name" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_configs" ADD CONSTRAINT "backup_configs_database_id_databases_id_fk" FOREIGN KEY ("database_id") REFERENCES "public"."databases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_configs" ADD CONSTRAINT "backup_configs_destination_id_s3_destinations_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."s3_destinations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backups" ADD CONSTRAINT "backups_config_id_backup_configs_id_fk" FOREIGN KEY ("config_id") REFERENCES "public"."backup_configs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backups" ADD CONSTRAINT "backups_database_id_databases_id_fk" FOREIGN KEY ("database_id") REFERENCES "public"."databases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backups" ADD CONSTRAINT "backups_destination_id_s3_destinations_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."s3_destinations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "databases" ADD CONSTRAINT "databases_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "databases" ADD CONSTRAINT "databases_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_logs" ADD CONSTRAINT "deployment_logs_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "env_vars" ADD CONSTRAINT "env_vars_database_id_databases_id_fk" FOREIGN KEY ("database_id") REFERENCES "public"."databases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "env_vars" ADD CONSTRAINT "env_vars_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_providers" ADD CONSTRAINT "github_providers_git_provider_id_git_providers_id_fk" FOREIGN KEY ("git_provider_id") REFERENCES "public"."git_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gitlab_providers" ADD CONSTRAINT "gitlab_providers_git_provider_id_git_providers_id_fk" FOREIGN KEY ("git_provider_id") REFERENCES "public"."git_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gitlab_repository_hooks" ADD CONSTRAINT "gitlab_repository_hooks_git_provider_id_git_providers_id_fk" FOREIGN KEY ("git_provider_id") REFERENCES "public"."git_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_disk_usage" ADD CONSTRAINT "server_disk_usage_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_metrics" ADD CONSTRAINT "server_metrics_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_metrics" ADD CONSTRAINT "service_metrics_database_id_databases_id_fk" FOREIGN KEY ("database_id") REFERENCES "public"."databases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_metrics" ADD CONSTRAINT "service_metrics_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environments" ADD CONSTRAINT "environments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "servers" ADD CONSTRAINT "servers_ssh_key_id_ssh_keys_id_fk" FOREIGN KEY ("ssh_key_id") REFERENCES "public"."ssh_keys"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_dependencies" ADD CONSTRAINT "service_dependencies_depends_on_database_id_databases_id_fk" FOREIGN KEY ("depends_on_database_id") REFERENCES "public"."databases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_dependencies" ADD CONSTRAINT "service_dependencies_depends_on_service_id_services_id_fk" FOREIGN KEY ("depends_on_service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_dependencies" ADD CONSTRAINT "service_dependencies_env_var_id_env_vars_id_fk" FOREIGN KEY ("env_var_id") REFERENCES "public"."env_vars"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_dependencies" ADD CONSTRAINT "service_dependencies_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_domains" ADD CONSTRAINT "service_domains_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_deploy_key_id_ssh_keys_id_fk" FOREIGN KEY ("deploy_key_id") REFERENCES "public"."ssh_keys"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_git_provider_id_git_providers_id_fk" FOREIGN KEY ("git_provider_id") REFERENCES "public"."git_providers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_preview_of_service_id_services_id_fk" FOREIGN KEY ("preview_of_service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_registry_id_registries_id_fk" FOREIGN KEY ("registry_id") REFERENCES "public"."registries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stack_deployment_logs" ADD CONSTRAINT "stack_deployment_logs_stack_deployment_id_stack_deployments_id_fk" FOREIGN KEY ("stack_deployment_id") REFERENCES "public"."stack_deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stack_deployments" ADD CONSTRAINT "stack_deployments_stack_id_stacks_id_fk" FOREIGN KEY ("stack_id") REFERENCES "public"."stacks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stacks" ADD CONSTRAINT "stacks_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stacks" ADD CONSTRAINT "stacks_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "volume_backup_configs" ADD CONSTRAINT "volume_backup_configs_destination_id_s3_destinations_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."s3_destinations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "volume_backup_configs" ADD CONSTRAINT "volume_backup_configs_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "volume_backups" ADD CONSTRAINT "volume_backups_config_id_volume_backup_configs_id_fk" FOREIGN KEY ("config_id") REFERENCES "public"."volume_backup_configs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "volume_backups" ADD CONSTRAINT "volume_backups_destination_id_s3_destinations_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."s3_destinations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "volume_backups" ADD CONSTRAINT "volume_backups_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_created_idx" ON "audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "audit_log_actor_idx" ON "audit_log" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "backup_configs_database_idx" ON "backup_configs" USING btree ("database_id");--> statement-breakpoint
CREATE INDEX "backups_database_created_idx" ON "backups" USING btree ("database_id","created_at");--> statement-breakpoint
CREATE INDEX "backups_config_created_idx" ON "backups" USING btree ("config_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "databases_env_name_idx" ON "databases" USING btree ("environment_id","name");--> statement-breakpoint
CREATE INDEX "deployment_logs_deployment_idx" ON "deployment_logs" USING btree ("deployment_id");--> statement-breakpoint
CREATE INDEX "deployments_service_created_idx" ON "deployments" USING btree ("service_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "env_vars_service_key_idx" ON "env_vars" USING btree ("service_id","key") WHERE "env_vars"."service_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "env_vars_database_key_idx" ON "env_vars" USING btree ("database_id","key") WHERE "env_vars"."database_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "git_providers_name_idx" ON "git_providers" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "gitlab_repository_hooks_idx" ON "gitlab_repository_hooks" USING btree ("git_provider_id","repository_full_name");--> statement-breakpoint
CREATE INDEX "server_disk_usage_server_time_idx" ON "server_disk_usage" USING btree ("server_id","sampled_at");--> statement-breakpoint
CREATE INDEX "server_metrics_server_time_idx" ON "server_metrics" USING btree ("server_id","sampled_at");--> statement-breakpoint
CREATE INDEX "service_metrics_service_time_idx" ON "service_metrics" USING btree ("service_id","sampled_at");--> statement-breakpoint
CREATE INDEX "service_metrics_database_time_idx" ON "service_metrics" USING btree ("database_id","sampled_at");--> statement-breakpoint
CREATE UNIQUE INDEX "environments_project_name_idx" ON "environments" USING btree ("project_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "environments_one_default_idx" ON "environments" USING btree ("project_id") WHERE "environments"."is_default" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "projects_name_idx" ON "projects" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "registries_name_idx" ON "registries" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "s3_destinations_name_idx" ON "s3_destinations" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "servers_host_port_user_idx" ON "servers" USING btree ("host","ssh_port","ssh_user");--> statement-breakpoint
CREATE UNIQUE INDEX "service_dependencies_database_idx" ON "service_dependencies" USING btree ("service_id","depends_on_database_id") WHERE "service_dependencies"."depends_on_database_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "service_dependencies_service_idx" ON "service_dependencies" USING btree ("service_id","depends_on_service_id") WHERE "service_dependencies"."depends_on_service_id" is not null;--> statement-breakpoint
CREATE INDEX "service_domains_service_idx" ON "service_domains" USING btree ("service_id");--> statement-breakpoint
CREATE UNIQUE INDEX "service_domains_host_idx" ON "service_domains" USING btree ("host");--> statement-breakpoint
CREATE UNIQUE INDEX "service_domains_service_host_idx" ON "service_domains" USING btree ("service_id","host");--> statement-breakpoint
CREATE UNIQUE INDEX "services_env_name_idx" ON "services" USING btree ("environment_id","name");--> statement-breakpoint
CREATE INDEX "services_server_idx" ON "services" USING btree ("server_id");--> statement-breakpoint
CREATE UNIQUE INDEX "services_preview_pr_idx" ON "services" USING btree ("preview_of_service_id","pr_number") WHERE "services"."preview_of_service_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "ssh_keys_name_idx" ON "ssh_keys" USING btree ("name");--> statement-breakpoint
CREATE INDEX "stack_deployment_logs_deployment_idx" ON "stack_deployment_logs" USING btree ("stack_deployment_id");--> statement-breakpoint
CREATE INDEX "stack_deployments_stack_created_idx" ON "stack_deployments" USING btree ("stack_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "stacks_env_name_idx" ON "stacks" USING btree ("environment_id","name");--> statement-breakpoint
CREATE INDEX "stacks_server_idx" ON "stacks" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "volume_backup_configs_service_idx" ON "volume_backup_configs" USING btree ("service_id");--> statement-breakpoint
CREATE INDEX "volume_backups_service_created_idx" ON "volume_backups" USING btree ("service_id","created_at");--> statement-breakpoint
CREATE INDEX "volume_backups_config_created_idx" ON "volume_backups" USING btree ("config_id","created_at");