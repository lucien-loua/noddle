-- Le nom Swarm des piles et des bases devient une COLONNE.
--
-- Écrite à la main, et pas telle que drizzle-kit l'a générée : il produit un
-- `ADD COLUMN ... NOT NULL` sec, qui RÉUSSIT sur une table vide et ÉCHOUE dès
-- qu'il existe une ligne (« column contains null values »). Il serait donc
-- passé au vert en développement et en CI, et n'aurait cassé que sur une
-- installation qui a des données — c'est-à-dire en production uniquement.
--
-- Les trois temps sont donc explicites : ajouter en NULLABLE, RÉTRO-REMPLIR à
-- la valeur que le code calculait jusqu'ici, puis verrouiller. La valeur
-- rétro-remplie n'est pas cosmétique : le nom d'une pile préfixe ses volumes et
-- celui d'une base nomme le sien, en plus d'être l'hôte des chaînes de
-- connexion déjà chiffrées. La changer ferait redémarrer ces ressources sur un
-- volume VIDE, sans erreur.
ALTER TABLE "databases" ADD COLUMN "swarm_name" text;--> statement-breakpoint
ALTER TABLE "stacks" ADD COLUMN "swarm_name" text;--> statement-breakpoint

UPDATE "databases" SET "swarm_name" = 'noddle-db-' || "name" WHERE "swarm_name" IS NULL;--> statement-breakpoint
UPDATE "stacks" SET "swarm_name" = "name" WHERE "swarm_name" IS NULL;--> statement-breakpoint

ALTER TABLE "databases" ALTER COLUMN "swarm_name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "stacks" ALTER COLUMN "swarm_name" SET NOT NULL;
