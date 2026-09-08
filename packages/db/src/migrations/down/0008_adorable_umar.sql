ALTER TABLE "projects" DROP CONSTRAINT "projects_team_id_organization_id_fk";--> statement-breakpoint
DROP INDEX "projects_team_idx";--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "team_id";--> statement-breakpoint
DROP TABLE "invitation";--> statement-breakpoint
DROP TABLE "member";--> statement-breakpoint
DROP TABLE "organization";
