ALTER TABLE "audit_log" DROP COLUMN "actor_token_name";--> statement-breakpoint
ALTER TABLE "audit_log" DROP COLUMN "actor_token_id";--> statement-breakpoint
ALTER TABLE "audit_log" DROP COLUMN "actor_kind";--> statement-breakpoint
DROP TYPE "public"."audit_actor_kind";
