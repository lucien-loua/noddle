ALTER TABLE "services" ADD COLUMN "webhook_secret_encrypted" text;--> statement-breakpoint
ALTER TABLE "stacks" ADD COLUMN "webhook_secret_encrypted" text;