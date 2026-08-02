CREATE TYPE "public"."server_role" AS ENUM('manager', 'worker');--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "role" "server_role" DEFAULT 'worker' NOT NULL;