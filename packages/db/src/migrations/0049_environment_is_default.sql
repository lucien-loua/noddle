ALTER TABLE "environments" ADD COLUMN "is_default" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "environments" AS e
SET "is_default" = true
FROM (
	SELECT DISTINCT ON ("project_id") "id"
	FROM "environments"
	ORDER BY "project_id", ("name" = 'production') DESC, "created_at" ASC
) AS picked
WHERE e."id" = picked."id";--> statement-breakpoint
INSERT INTO "environments" ("name", "project_id", "is_default")
SELECT 'production', p."id", true
FROM "projects" AS p
WHERE NOT EXISTS (
	SELECT 1 FROM "environments" AS e WHERE e."project_id" = p."id"
);--> statement-breakpoint
CREATE UNIQUE INDEX "environments_one_default_idx" ON "environments" USING btree ("project_id") WHERE "environments"."is_default" = true;
