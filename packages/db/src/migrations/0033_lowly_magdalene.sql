DROP INDEX "env_vars_service_key_idx";--> statement-breakpoint
ALTER TABLE "env_vars" ALTER COLUMN "service_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "env_vars" ADD COLUMN "database_id" uuid;--> statement-breakpoint
ALTER TABLE "env_vars" ADD CONSTRAINT "env_vars_database_id_databases_id_fk" FOREIGN KEY ("database_id") REFERENCES "public"."databases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "env_vars_database_key_idx" ON "env_vars" USING btree ("database_id","key") WHERE "env_vars"."database_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "env_vars_service_key_idx" ON "env_vars" USING btree ("service_id","key") WHERE "env_vars"."service_id" is not null;--> statement-breakpoint
ALTER TABLE "env_vars" ADD CONSTRAINT "env_vars_one_owner" CHECK (("env_vars"."service_id" is null) <> ("env_vars"."database_id" is null));