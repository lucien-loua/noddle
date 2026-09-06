ALTER TABLE "control_plane_settings" DROP CONSTRAINT IF EXISTS "control_plane_settings_backup_destination_id_s3_destinations_id_fk";--> statement-breakpoint
ALTER TABLE "control_plane_settings" DROP COLUMN IF EXISTS "backup_destination_id";
