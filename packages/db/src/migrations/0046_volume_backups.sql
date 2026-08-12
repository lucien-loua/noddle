CREATE TABLE "volume_backup_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_id" uuid NOT NULL,
	"volume_name" text NOT NULL,
	"mount_path" text,
	"destination_id" uuid NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"keep_latest_count" integer,
	"prefix" text DEFAULT '' NOT NULL,
	"schedule" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "volume_backups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"config_id" uuid,
	"service_id" uuid NOT NULL,
	"destination_id" uuid,
	"object_key" text NOT NULL,
	"status" "backup_status" DEFAULT 'queued' NOT NULL,
	"kind" "backup_kind" DEFAULT 'manual' NOT NULL,
	"size_bytes" bigint DEFAULT 0 NOT NULL,
	"error_message" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "volume_backup_configs" ADD CONSTRAINT "volume_backup_configs_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "volume_backup_configs" ADD CONSTRAINT "volume_backup_configs_destination_id_s3_destinations_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."s3_destinations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "volume_backups" ADD CONSTRAINT "volume_backups_config_id_volume_backup_configs_id_fk" FOREIGN KEY ("config_id") REFERENCES "public"."volume_backup_configs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "volume_backups" ADD CONSTRAINT "volume_backups_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "volume_backups" ADD CONSTRAINT "volume_backups_destination_id_s3_destinations_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."s3_destinations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "volume_backup_configs_service_idx" ON "volume_backup_configs" USING btree ("service_id");
--> statement-breakpoint
CREATE INDEX "volume_backups_service_created_idx" ON "volume_backups" USING btree ("service_id","created_at");
--> statement-breakpoint
CREATE INDEX "volume_backups_config_created_idx" ON "volume_backups" USING btree ("config_id","created_at");
