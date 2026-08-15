CREATE TABLE "gitlab_providers" (
	"access_token_encrypted" text,
	"application_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"git_provider_id" uuid PRIMARY KEY NOT NULL,
	"group_name" text,
	"redirect_uri" text,
	"refresh_token_encrypted" text,
	"secret_encrypted" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"url" text DEFAULT 'https://gitlab.com' NOT NULL,
	"webhook_secret_encrypted" text
);
--> statement-breakpoint
ALTER TABLE "gitlab_providers" ADD CONSTRAINT "gitlab_providers_git_provider_id_git_providers_id_fk" FOREIGN KEY ("git_provider_id") REFERENCES "public"."git_providers"("id") ON DELETE cascade ON UPDATE no action;