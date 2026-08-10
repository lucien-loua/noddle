ALTER TABLE "databases" ADD COLUMN "extra_mounts" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "databases" ADD COLUMN "replicas" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "databases" ADD COLUMN "swarm_settings" jsonb;--> statement-breakpoint
ALTER TABLE "databases" ADD COLUMN "volume_path" text;