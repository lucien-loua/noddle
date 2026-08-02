CREATE TYPE "public"."build_method" AS ENUM('nixpacks', 'dockerfile', 'image');--> statement-breakpoint
CREATE TYPE "public"."deployment_status" AS ENUM('queued', 'building', 'deploying', 'succeeded', 'failed', 'rolled_back', 'reverted_by_watch');--> statement-breakpoint
CREATE TYPE "public"."deployment_trigger" AS ENUM('manual', 'webhook', 'rollback', 'watch_revert');--> statement-breakpoint
CREATE TYPE "public"."server_status" AS ENUM('pending', 'connected', 'unreachable');--> statement-breakpoint
CREATE TYPE "public"."service_status" AS ENUM('created', 'deploying', 'running', 'stopped', 'crashed');--> statement-breakpoint
CREATE TYPE "public"."source_type" AS ENUM('git', 'docker_image', 'compose');--> statement-breakpoint
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
	"image_tag" text,
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
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"is_secret" boolean DEFAULT false NOT NULL,
	"key" text NOT NULL,
	"service_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"value_encrypted" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "environments" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"project_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
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
	"name" text NOT NULL,
	"ssh_port" integer DEFAULT 22 NOT NULL,
	"ssh_private_key_encrypted" text NOT NULL,
	"ssh_user" text NOT NULL,
	"status" "server_status" DEFAULT 'pending' NOT NULL,
	"total_memory_mb" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "services" (
	"build_method" "build_method" DEFAULT 'nixpacks' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"current_deployment_id" uuid,
	"domain" text,
	"environment_id" uuid NOT NULL,
	"git_branch" text,
	"git_repo_url" text,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"port" integer DEFAULT 3000 NOT NULL,
	"server_id" uuid NOT NULL,
	"source_type" "source_type" NOT NULL,
	"status" "service_status" DEFAULT 'created' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "deployment_logs" ADD CONSTRAINT "deployment_logs_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "env_vars" ADD CONSTRAINT "env_vars_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environments" ADD CONSTRAINT "environments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deployment_logs_deployment_idx" ON "deployment_logs" USING btree ("deployment_id");--> statement-breakpoint
CREATE INDEX "deployments_service_created_idx" ON "deployments" USING btree ("service_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "env_vars_service_key_idx" ON "env_vars" USING btree ("service_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "environments_project_name_idx" ON "environments" USING btree ("project_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "servers_host_port_user_idx" ON "servers" USING btree ("host","ssh_port","ssh_user");--> statement-breakpoint
CREATE UNIQUE INDEX "services_env_name_idx" ON "services" USING btree ("environment_id","name");--> statement-breakpoint
CREATE INDEX "services_server_idx" ON "services" USING btree ("server_id");