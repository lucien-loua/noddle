CREATE TYPE "public"."database_engine" AS ENUM('postgres', 'redis');--> statement-breakpoint
CREATE TABLE "databases" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"engine" "database_engine" NOT NULL,
	"environment_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"root_password_encrypted" text NOT NULL,
	"root_user" text,
	"server_id" uuid NOT NULL,
	"status" "service_status" DEFAULT 'created' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "databases" ADD CONSTRAINT "databases_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "databases" ADD CONSTRAINT "databases_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "databases_env_name_idx" ON "databases" USING btree ("environment_id","name");