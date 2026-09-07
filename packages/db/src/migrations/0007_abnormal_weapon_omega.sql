CREATE TYPE "public"."audit_actor_kind" AS ENUM('session', 'token');--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "actor_kind" "audit_actor_kind" DEFAULT 'session' NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "actor_token_id" text;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "actor_token_name" text;