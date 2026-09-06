ALTER TABLE "control_plane_settings" DROP COLUMN IF EXISTS "backup_last_at";--> statement-breakpoint
ALTER TABLE "control_plane_settings" DROP COLUMN IF EXISTS "backup_last_bytes";--> statement-breakpoint
ALTER TABLE "control_plane_settings" DROP COLUMN IF EXISTS "backup_last_error";--> statement-breakpoint
ALTER TABLE "control_plane_settings" DROP COLUMN IF EXISTS "backup_last_key";
