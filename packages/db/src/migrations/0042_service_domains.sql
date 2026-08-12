CREATE TABLE "service_domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_id" uuid NOT NULL,
	"host" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
INSERT INTO "service_domains" ("service_id", "host")
SELECT "id", "domain" FROM "services" WHERE "domain" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "service_domains" ADD CONSTRAINT "service_domains_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "service_domains_service_idx" ON "service_domains" USING btree ("service_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "service_domains_host_idx" ON "service_domains" USING btree ("host");
--> statement-breakpoint
CREATE UNIQUE INDEX "service_domains_service_host_idx" ON "service_domains" USING btree ("service_id","host");
--> statement-breakpoint
ALTER TABLE "services" DROP COLUMN "domain";
