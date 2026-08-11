CREATE TABLE "backup_configs" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"database_id" uuid NOT NULL,
	"database_name" text NOT NULL,
	"destination_id" uuid NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"keep_latest_count" integer,
	"prefix" text DEFAULT '' NOT NULL,
	"schedule" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "databases" DROP CONSTRAINT "databases_s3_destination_id_s3_destinations_id_fk";
--> statement-breakpoint
ALTER TABLE "backups" ADD COLUMN "config_id" uuid;--> statement-breakpoint
ALTER TABLE "backup_configs" ADD CONSTRAINT "backup_configs_database_id_databases_id_fk" FOREIGN KEY ("database_id") REFERENCES "public"."databases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_configs" ADD CONSTRAINT "backup_configs_destination_id_s3_destinations_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."s3_destinations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "backup_configs_database_idx" ON "backup_configs" USING btree ("database_id");--> statement-breakpoint
ALTER TABLE "backups" ADD CONSTRAINT "backups_config_id_backup_configs_id_fk" FOREIGN KEY ("config_id") REFERENCES "public"."backup_configs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "backups_config_created_idx" ON "backups" USING btree ("config_id","created_at");--> statement-breakpoint
-- Migrate legacy per-database schedule into one config row when possible.
INSERT INTO "backup_configs" (
	"database_id",
	"database_name",
	"destination_id",
	"enabled",
	"keep_latest_count",
	"prefix",
	"schedule"
)
SELECT
	d."id",
	COALESCE(NULLIF(d."database_name", ''), d."name"),
	d."s3_destination_id",
	true,
	d."backup_retention",
	'',
	CASE d."backup_schedule"
		WHEN 'daily' THEN '0 0 * * *'
		WHEN 'weekly' THEN '0 0 * * 0'
		ELSE '0 0 * * *'
	END
FROM "databases" d
WHERE d."backup_schedule" <> 'off'
	AND d."s3_destination_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "databases" DROP COLUMN "backup_retention";--> statement-breakpoint
ALTER TABLE "databases" DROP COLUMN "backup_schedule";--> statement-breakpoint
ALTER TABLE "databases" DROP COLUMN "s3_destination_id";--> statement-breakpoint
DROP TYPE "public"."backup_schedule";
