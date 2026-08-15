ALTER TABLE "services" ADD COLUMN "auto_deploy" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "clean_cache" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "git_submodules" boolean DEFAULT false NOT NULL;