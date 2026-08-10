--> GÉNÉRÉE par drizzle-kit, puis ÉDITÉE À LA MAIN sur deux points. Ne pas la
--> régénérer sans relire ce qui suit.
-->
--> 1. `ADD COLUMN "name" text NOT NULL` tel que généré RÉUSSIT sur une table
-->    vide et ÉCHOUE dès qu'il existe une ligne. Il serait donc passé au vert
-->    en développement et en CI — où cette table est vide — et n'aurait cassé
-->    que sur une installation qui a déjà une destination, c'est-à-dire en
-->    production uniquement. Découpé en NULLABLE → remplissage → contrainte.
-->    Même famille que 0016/0017 (`swarm_name`).
-->
--> 2. `backups.destination_id` est rétro-rempli à la seule destination qui
-->    existait, vrai par construction pour toute ligne écrite avant. Sans ça,
-->    une restauration d'une sauvegarde ancienne ne saurait plus dans quel
-->    compartiment aller la chercher.
-->
--> CE QUI NE CHANGE PAS, et c'est le piège de ce renommage : l'AAD du
--> chiffrement reste `backup_destination:<id>`. Il est AUTHENTIFIÉ — le
--> renommer rendrait toute clé secrète déjà stockée indéchiffrable, sans
--> erreur au typecheck et sans rien pour le signaler avant la première
--> sauvegarde.

ALTER TABLE "backup_destinations" RENAME TO "s3_destinations";--> statement-breakpoint
ALTER TABLE "s3_destinations" DROP CONSTRAINT "backup_destinations_singleton_true";--> statement-breakpoint
DROP INDEX "backup_destinations_singleton_idx";--> statement-breakpoint
ALTER TABLE "s3_destinations" ADD COLUMN "name" text;--> statement-breakpoint
UPDATE "s3_destinations" SET "name" = 'Default' WHERE "name" IS NULL;--> statement-breakpoint
ALTER TABLE "s3_destinations" ALTER COLUMN "name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "backups" ADD COLUMN "destination_id" uuid;--> statement-breakpoint
ALTER TABLE "databases" ADD COLUMN "s3_destination_id" uuid;--> statement-breakpoint
UPDATE "backups" SET "destination_id" = (SELECT "id" FROM "s3_destinations" LIMIT 1) WHERE "destination_id" IS NULL;--> statement-breakpoint
ALTER TABLE "backups" ADD CONSTRAINT "backups_destination_id_s3_destinations_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."s3_destinations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "databases" ADD CONSTRAINT "databases_s3_destination_id_s3_destinations_id_fk" FOREIGN KEY ("s3_destination_id") REFERENCES "public"."s3_destinations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "s3_destinations_name_idx" ON "s3_destinations" USING btree ("name");--> statement-breakpoint
ALTER TABLE "s3_destinations" DROP COLUMN "singleton";