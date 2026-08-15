ALTER TABLE "services" ADD COLUMN "build_path" text;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "watch_paths" text[] DEFAULT '{}' NOT NULL;