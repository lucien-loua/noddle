ALTER TABLE "control_plane_settings" ADD COLUMN "backup_last_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "control_plane_settings" ADD COLUMN "backup_last_bytes" bigint;--> statement-breakpoint
ALTER TABLE "control_plane_settings" ADD COLUMN "backup_last_error" text;--> statement-breakpoint
ALTER TABLE "control_plane_settings" ADD COLUMN "backup_last_key" text;