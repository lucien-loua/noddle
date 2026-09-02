CREATE TYPE "public"."control_plane_status" AS ENUM('idle', 'applying', 'failed');--> statement-breakpoint
CREATE TABLE "control_plane_settings" (
	"acme_email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"domain" text,
	"https_enabled" boolean DEFAULT false NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"last_error" text,
	"status" "control_plane_status" DEFAULT 'idle' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
