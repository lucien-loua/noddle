CREATE TYPE "public"."backup_kind" AS ENUM('manual', 'scheduled', 'pre_restore');--> statement-breakpoint
CREATE TYPE "public"."backup_status" AS ENUM('queued', 'running', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "backup_destinations" (
	"access_key_id" text NOT NULL,
	"bucket" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"endpoint" text NOT NULL,
	"force_path_style" boolean DEFAULT true NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"prefix" text DEFAULT '' NOT NULL,
	"region" text DEFAULT 'us-east-1' NOT NULL,
	"secret_access_key_encrypted" text NOT NULL,
	"singleton" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "backup_destinations_singleton_true" CHECK ("backup_destinations"."singleton")
);
--> statement-breakpoint
CREATE TABLE "backups" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"database_id" uuid NOT NULL,
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
ALTER TABLE "backups" ADD CONSTRAINT "backups_database_id_databases_id_fk" FOREIGN KEY ("database_id") REFERENCES "public"."databases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "backup_destinations_singleton_idx" ON "backup_destinations" USING btree ("singleton");--> statement-breakpoint
CREATE INDEX "backups_database_created_idx" ON "backups" USING btree ("database_id","created_at");