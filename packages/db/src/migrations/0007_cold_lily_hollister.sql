CREATE TYPE "public"."backup_schedule" AS ENUM('off', 'daily', 'weekly');--> statement-breakpoint
ALTER TABLE "databases" ADD COLUMN "backup_retention" integer DEFAULT 7 NOT NULL;--> statement-breakpoint
ALTER TABLE "databases" ADD COLUMN "backup_schedule" "backup_schedule" DEFAULT 'off' NOT NULL;