CREATE TABLE "registries" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"image_prefix" text DEFAULT '' NOT NULL,
	"name" text NOT NULL,
	"password_encrypted" text NOT NULL,
	"registry_url" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"username" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "registries_name_idx" ON "registries" USING btree ("name");