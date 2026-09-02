CREATE TABLE "database_deployment_logs" (
	"byte_size" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"database_deployment_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"storage_url" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "database_deployments" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"database_id" uuid NOT NULL,
	"error_message" text,
	"finished_at" timestamp with time zone,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"image" text,
	"started_at" timestamp with time zone,
	"status" "deployment_status" DEFAULT 'queued' NOT NULL,
	"swarm_update_state" text,
	"trigger" "deployment_trigger" DEFAULT 'manual' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "database_deployment_logs" ADD CONSTRAINT "database_deployment_logs_database_deployment_id_database_deployments_id_fk" FOREIGN KEY ("database_deployment_id") REFERENCES "public"."database_deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_deployments" ADD CONSTRAINT "database_deployments_database_id_databases_id_fk" FOREIGN KEY ("database_id") REFERENCES "public"."databases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "database_deployment_logs_deployment_idx" ON "database_deployment_logs" USING btree ("database_deployment_id");--> statement-breakpoint
CREATE INDEX "database_deployments_database_created_idx" ON "database_deployments" USING btree ("database_id","created_at");