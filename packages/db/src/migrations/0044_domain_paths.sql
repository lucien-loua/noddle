ALTER TABLE "service_domains" ADD COLUMN "path" text DEFAULT '/' NOT NULL;
--> statement-breakpoint
ALTER TABLE "service_domains" ADD COLUMN "internal_path" text;
--> statement-breakpoint
ALTER TABLE "service_domains" ADD COLUMN "strip_path" boolean DEFAULT false NOT NULL;
