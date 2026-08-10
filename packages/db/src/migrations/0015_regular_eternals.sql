ALTER TABLE "services" ADD COLUMN "preview_of_service_id" uuid;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "pr_number" integer;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_preview_of_service_id_services_id_fk" FOREIGN KEY ("preview_of_service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "services_preview_pr_idx" ON "services" USING btree ("preview_of_service_id","pr_number") WHERE "services"."preview_of_service_id" is not null;