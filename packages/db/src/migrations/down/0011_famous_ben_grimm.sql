ALTER TABLE "apikey" DROP CONSTRAINT "apikey_team_id_organization_id_fk";--> statement-breakpoint
DROP INDEX "apikey_team_idx";--> statement-breakpoint
ALTER TABLE "apikey" DROP COLUMN "team_id";