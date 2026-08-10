-- La bibliothèque de clés SSH, et la reprise des clés déjà en place.
--
-- DDL généré par drizzle-kit, reprise des données ajoutée à la main, et
-- l'index unique DÉPLACÉ après la désambiguïsation des noms — posé avant, il
-- refuserait deux serveurs homonymes, c'est-à-dire une base parfaitement
-- valide.
--
-- LE POINT DÉLICAT : la clé privée est chiffrée en AES-256-GCM sous un AAD qui
-- vaut `server_ssh_key:<id du serveur>`. Le SQL ne peut ni déchiffrer ni
-- rechiffrer — il n'a ni l'APP_KEY ni GCM. Chaque ligne de `ssh_keys` reprend
-- donc l'IDENTIFIANT du serveur dont elle vient et copie le chiffré octet pour
-- octet : l'AAD reste exact, rien n'est réécrit, et la première connexion après
-- migration ouvre la clé comme avant.

CREATE TABLE "ssh_keys" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"private_key_encrypted" text NOT NULL,
	"public_key" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "ssh_key_id" uuid;--> statement-breakpoint

-- Une clé par serveur existant, l'identifiant repris tel quel (voir plus haut).
INSERT INTO "ssh_keys" ("id", "name", "private_key_encrypted", "created_at")
SELECT s."id", s."name", s."ssh_private_key_encrypted", s."created_at"
FROM "servers" s;--> statement-breakpoint

-- `servers.name` n'est pas unique alors que `ssh_keys.name` va l'être. Les
-- homonymes sont désambiguïsés plutôt que refusés — sur l'identifiant, seul
-- discriminant garanti, et pas sur l'hôte qui peut lui aussi se répéter.
UPDATE "ssh_keys" k
SET "name" = k."name" || ' (' || left(k."id"::text, 8) || ')'
FROM (
	SELECT "id", row_number() OVER (PARTITION BY "name" ORDER BY "created_at", "id") AS "rn"
	FROM "ssh_keys"
) d
WHERE d."id" = k."id" AND d."rn" > 1;--> statement-breakpoint

CREATE UNIQUE INDEX "ssh_keys_name_idx" ON "ssh_keys" USING btree ("name");--> statement-breakpoint
ALTER TABLE "servers" ADD CONSTRAINT "servers_ssh_key_id_ssh_keys_id_fk" FOREIGN KEY ("ssh_key_id") REFERENCES "public"."ssh_keys"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

UPDATE "servers" SET "ssh_key_id" = "id";
