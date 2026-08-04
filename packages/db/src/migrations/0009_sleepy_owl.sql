CREATE TABLE "server_metrics" (
	"cpu_count" bigint NOT NULL,
	"cpu_load1" real NOT NULL,
	"disk_total_bytes" bigint NOT NULL,
	"disk_used_bytes" bigint NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"memory_total_bytes" bigint NOT NULL,
	"memory_used_bytes" bigint NOT NULL,
	"sampled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"server_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_metrics" (
	"cpu_percent" real NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"memory_limit_bytes" bigint NOT NULL,
	"memory_used_bytes" bigint NOT NULL,
	"sampled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"service_id" uuid NOT NULL,
	"task_name" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "server_metrics" ADD CONSTRAINT "server_metrics_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_metrics" ADD CONSTRAINT "service_metrics_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "server_metrics_server_time_idx" ON "server_metrics" USING btree ("server_id","sampled_at");--> statement-breakpoint
CREATE INDEX "service_metrics_service_time_idx" ON "service_metrics" USING btree ("service_id","sampled_at");