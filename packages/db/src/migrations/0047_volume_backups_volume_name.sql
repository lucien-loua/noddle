ALTER TABLE "volume_backups" ADD COLUMN "volume_name" text;
--> statement-breakpoint
UPDATE "volume_backups"
SET "volume_name" = (regexp_match("object_key", '/([^/]+)/[^/]+\.tar\.gz$'))[1]
WHERE "volume_name" IS NULL;
--> statement-breakpoint
ALTER TABLE "volume_backups" ALTER COLUMN "volume_name" SET NOT NULL;
