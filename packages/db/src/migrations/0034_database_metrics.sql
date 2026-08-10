ALTER TABLE "service_metrics" ALTER COLUMN "service_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "service_metrics" ADD COLUMN "database_id" uuid;--> statement-breakpoint
ALTER TABLE "service_metrics" ADD CONSTRAINT "service_metrics_database_id_databases_id_fk" FOREIGN KEY ("database_id") REFERENCES "public"."databases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "service_metrics_database_time_idx" ON "service_metrics" USING btree ("database_id","sampled_at");--> statement-breakpoint
ALTER TABLE "service_metrics" ADD CONSTRAINT "service_metrics_one_owner" CHECK (("service_metrics"."service_id" is null) <> ("service_metrics"."database_id" is null));