-- Trois moteurs de plus dans `database_engine`.
--
-- `ALTER TYPE … ADD VALUE` a une réputation de piège : jusqu'à PostgreSQL 11
-- il était INTERDIT dans un bloc de transaction, et drizzle enveloppe chaque
-- migration dans une transaction. Depuis 12 il est permis, à une condition —
-- la valeur ajoutée ne peut pas être UTILISÉE dans la même transaction. On ne
-- fait qu'ajouter ici, aucune ligne n'est écrite avec ces valeurs, donc la
-- condition est tenue. Vérifié contre le PostgreSQL 17 de développement avant
-- d'être livré, pas déduit de la documentation.
--
-- `IF NOT EXISTS` rend la migration rejouable : sans lui, une seconde
-- exécution échouerait sur « enum label already exists ».
ALTER TYPE "database_engine" ADD VALUE IF NOT EXISTS 'mysql';--> statement-breakpoint
ALTER TYPE "database_engine" ADD VALUE IF NOT EXISTS 'mariadb';--> statement-breakpoint
ALTER TYPE "database_engine" ADD VALUE IF NOT EXISTS 'mongo';
