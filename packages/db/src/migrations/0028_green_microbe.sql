ALTER TABLE "projects" ADD COLUMN "description" text;--> statement-breakpoint
CREATE UNIQUE INDEX "projects_name_idx" ON "projects" USING btree ("name");