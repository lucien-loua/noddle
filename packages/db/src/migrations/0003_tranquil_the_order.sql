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
	"name" text NOT NULL,
	"port" integer,
	"public_service" text,
	"server_id" uuid NOT NULL,
	"status" "service_status" DEFAULT 'created' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "stack_deployment_logs" ADD CONSTRAINT "stack_deployment_logs_stack_deployment_id_stack_deployments_id_fk" FOREIGN KEY ("stack_deployment_id") REFERENCES "public"."stack_deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stack_deployments" ADD CONSTRAINT "stack_deployments_stack_id_stacks_id_fk" FOREIGN KEY ("stack_id") REFERENCES "public"."stacks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stacks" ADD CONSTRAINT "stacks_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stacks" ADD CONSTRAINT "stacks_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stack_deployment_logs_deployment_idx" ON "stack_deployment_logs" USING btree ("stack_deployment_id");--> statement-breakpoint
CREATE INDEX "stack_deployments_stack_created_idx" ON "stack_deployments" USING btree ("stack_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "stacks_env_name_idx" ON "stacks" USING btree ("environment_id","name");--> statement-breakpoint
CREATE INDEX "stacks_server_idx" ON "stacks" USING btree ("server_id");