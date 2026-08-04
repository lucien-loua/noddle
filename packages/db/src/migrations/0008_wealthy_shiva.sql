CREATE TYPE "public"."notification_kind" AS ENUM('webhook', 'discord', 'slack');--> statement-breakpoint
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
