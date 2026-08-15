CREATE TYPE "public"."git_provider_type" AS ENUM('github', 'gitlab');--> statement-breakpoint
CREATE TABLE "git_providers" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"provider_type" "git_provider_type" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_providers" (
	"app_id" text,
	"app_name" text,
	"client_id" text,
	"client_secret_encrypted" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"git_provider_id" uuid PRIMARY KEY NOT NULL,
	"installation_id" text,
	"private_key_encrypted" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"url" text DEFAULT 'https://github.com' NOT NULL,
	"webhook_secret_encrypted" text
);
--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "git_provider_id" uuid;--> statement-breakpoint
ALTER TABLE "github_providers" ADD CONSTRAINT "github_providers_git_provider_id_git_providers_id_fk" FOREIGN KEY ("git_provider_id") REFERENCES "public"."git_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "git_providers_name_idx" ON "git_providers" USING btree ("name");--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_git_provider_id_git_providers_id_fk" FOREIGN KEY ("git_provider_id") REFERENCES "public"."git_providers"("id") ON DELETE set null ON UPDATE no action;