-- GitHub and GitLab are git remotes with a remembered tab; docker_image
-- already existed on the enum and now has a column for the published image.
--
-- ADD VALUE inside drizzle's transaction is allowed since Postgres 12 as
-- long as the new labels are not USED in the same transaction. We only add
-- them here. IF NOT EXISTS makes a replay a no-op.
ALTER TYPE "public"."source_type" ADD VALUE IF NOT EXISTS 'github' BEFORE 'docker_image';--> statement-breakpoint
ALTER TYPE "public"."source_type" ADD VALUE IF NOT EXISTS 'gitlab' BEFORE 'docker_image';--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "docker_image" text;
