ALTER TABLE "apikey" ADD COLUMN "team_id" text;--> statement-breakpoint
ALTER TABLE "apikey" ADD CONSTRAINT "apikey_team_id_organization_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "apikey_team_idx" ON "apikey" USING btree ("team_id");--> statement-breakpoint
UPDATE "apikey" SET "team_id" = (SELECT "member"."organization_id" FROM "member" WHERE "member"."user_id" = "apikey"."reference_id" ORDER BY "member"."created_at", "member"."organization_id" LIMIT 1) WHERE "team_id" IS NULL;