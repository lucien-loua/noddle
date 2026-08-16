CREATE TABLE "gitlab_repository_hooks" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"git_provider_id" uuid NOT NULL,
	"hook_id" text,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"last_error" text,
	"repository_full_name" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gitlab_repository_hooks" ADD CONSTRAINT "gitlab_repository_hooks_git_provider_id_git_providers_id_fk" FOREIGN KEY ("git_provider_id") REFERENCES "public"."git_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "gitlab_repository_hooks_idx" ON "gitlab_repository_hooks" USING btree ("git_provider_id","repository_full_name");