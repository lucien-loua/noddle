CREATE TABLE "service_dependencies" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"depends_on_database_id" uuid,
	"depends_on_service_id" uuid,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_id" uuid NOT NULL,
	CONSTRAINT "service_dependencies_one_target" CHECK (("service_dependencies"."depends_on_service_id" is null) <> ("service_dependencies"."depends_on_database_id" is null)),
	CONSTRAINT "service_dependencies_no_self" CHECK ("service_dependencies"."depends_on_service_id" is distinct from "service_dependencies"."service_id")
);
--> statement-breakpoint
ALTER TABLE "service_dependencies" ADD CONSTRAINT "service_dependencies_depends_on_database_id_databases_id_fk" FOREIGN KEY ("depends_on_database_id") REFERENCES "public"."databases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_dependencies" ADD CONSTRAINT "service_dependencies_depends_on_service_id_services_id_fk" FOREIGN KEY ("depends_on_service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_dependencies" ADD CONSTRAINT "service_dependencies_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "service_dependencies_database_idx" ON "service_dependencies" USING btree ("service_id","depends_on_database_id") WHERE "service_dependencies"."depends_on_database_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "service_dependencies_service_idx" ON "service_dependencies" USING btree ("service_id","depends_on_service_id") WHERE "service_dependencies"."depends_on_service_id" is not null;