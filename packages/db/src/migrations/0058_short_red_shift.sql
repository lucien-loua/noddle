ALTER TABLE "services" ADD COLUMN "git_repo_full_name" text;--> statement-breakpoint
-- Backfill for services already cloning through a connection.
--
-- The whole path after the host, not the last two segments: that is what
-- both forges call the repository. GitHub's `full_name` is always two
-- segments, so taking everything costs nothing there and is the only way a
-- GitLab subgroup (`group/sub/app`) comes out matching the
-- `path_with_namespace` its webhook sends.
--
-- Guarded on two segments so a malformed URL leaves NULL rather than junk —
-- NULL falls back to the URL-derived slug, junk would match nothing.
UPDATE "services" AS s
SET "git_repo_full_name" = c.full_name
FROM (
  SELECT
    "id",
    lower(
      rtrim(
        regexp_replace(
          regexp_replace(
            regexp_replace("git_repo_url", '^[a-zA-Z][a-zA-Z0-9+.-]*://[^/]+/', ''),
            '^git@[^:]+:', ''
          ),
          '\.git$', ''
        ),
        '/'
      )
    ) AS full_name
  FROM "services"
  WHERE "git_provider_id" IS NOT NULL AND "git_repo_url" IS NOT NULL
) AS c
WHERE s."id" = c."id" AND c.full_name ~ '^[^/]+/[^/]+';
