-- Hand-modified after `drizzle-kit generate`.
--
-- The generated version dropped and recreated the type, then cast the column
-- back with `USING "build_method"::"public"."build_method"`. That fails on any
-- existing row whose value is 'nixpacks' — which is every service that ever
-- built from source, since it was the column default.
--
-- RENAME VALUE migrates the data in place instead: one catalog update, no table
-- rewrite, no row left holding a value the type no longer admits.
ALTER TYPE "public"."build_method" RENAME VALUE 'nixpacks' TO 'railpack';--> statement-breakpoint
-- The default is stored as a literal cast to the type, and the rename above
-- does not rewrite it.
ALTER TABLE "services" ALTER COLUMN "build_method" SET DEFAULT 'railpack'::"public"."build_method";
