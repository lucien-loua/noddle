-- Databases and stacks gain a display name too; their IDENTITIES stay put.
--
-- Same shape as 0063, and safe for the same reason: nullable, so there is no
-- `NOT NULL` to violate on tables that already have rows, and nothing to
-- backfill. `null` means "never renamed" and the UI falls back to `name`.
--
-- Both tables already froze their Swarm name into a column back in 0016, so
-- `name` no longer feeds the running service here. It is still the identity
-- the typed delete confirmation is checked against, which is why renaming
-- goes to a separate column rather than to `name`.
ALTER TABLE "databases" ADD COLUMN "display_name" text;--> statement-breakpoint
ALTER TABLE "stacks" ADD COLUMN "display_name" text;