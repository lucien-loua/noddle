CREATE TYPE "certificate_type" AS ENUM('none', 'letsencrypt');
--> statement-breakpoint
ALTER TABLE "service_domains" ADD COLUMN "https" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "service_domains" ADD COLUMN "certificate_type" "certificate_type" DEFAULT 'none' NOT NULL;
