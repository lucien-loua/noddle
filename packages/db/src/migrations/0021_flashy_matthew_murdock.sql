CREATE TABLE "server_disk_usage" (
	"build_cache_bytes" bigint NOT NULL,
	"build_cache_count" bigint NOT NULL,
	"build_cache_reclaimable_bytes" bigint NOT NULL,
	"container_bytes" bigint NOT NULL,
	"container_count" bigint NOT NULL,
	"container_reclaimable_bytes" bigint NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"image_bytes" bigint NOT NULL,
	"image_count" bigint NOT NULL,
	"image_reclaimable_bytes" bigint NOT NULL,
	"sampled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"server_id" uuid NOT NULL,
	"volume_bytes" bigint NOT NULL,
	"volume_count" bigint NOT NULL,
	"volume_reclaimable_bytes" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "server_disk_usage" ADD CONSTRAINT "server_disk_usage_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "server_disk_usage_server_time_idx" ON "server_disk_usage" USING btree ("server_id","sampled_at");