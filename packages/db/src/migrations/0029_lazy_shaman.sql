ALTER TABLE "databases" ADD COLUMN "database_name" text;--> statement-breakpoint
ALTER TABLE "databases" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "databases" ADD COLUMN "image" text;--> statement-breakpoint
-- Ajouté à la main : drizzle-kit ne rend que les trois ADD COLUMN ci-dessus.
--
-- Jusqu'ici le nom de la base ÉTAIT celui de l'utilisateur — `database.ts`
-- posait `POSTGRES_DB=${rootUser}`. Laisser `database_name` à NULL sur les
-- lignes existantes ferait donc viser un AUTRE nom qu'avant : la chaîne de
-- connexion, `pg_dump` et `pg_restore` retomberaient sur un défaut, sans une
-- seule erreur pour le dire. On fige la valeur qui a réellement été utilisée.
--
-- Redis reste à NULL : `root_user` y est NULL et le moteur n'a pas la notion.
UPDATE "databases" SET "database_name" = "root_user" WHERE "root_user" IS NOT NULL;
