-- Migration ÉCRITE À LA MAIN : drizzle-kit n'a rien à générer ici, le schéma
-- ne change pas. Seules les DONNÉES sont en cause.
--
-- `databases.image` a été ajoutée nullable par 0029, et le worker faisait
-- `database.image ?? spec.image` : une base sans image choisie ne fige donc
-- aucune version — elle prend celle qui est en dur dans le code AU MOMENT DU
-- DÉPLOIEMENT. Tant que la table des défauts ne bouge pas, ça ne se voit pas.
-- Le jour où elle bouge, chaque base restante redémarre sur une AUTRE version
-- majeure, par-dessus le volume écrit par la précédente : Postgres refuse net
-- un répertoire de données plus ancien, et un moteur qui ne refuserait pas
-- serait pire — il démarrerait.
--
-- On fige donc la valeur qui a RÉELLEMENT servi jusqu'ici, moteur par moteur.
-- Ces deux chaînes sont celles de `DEFAULT_DATABASE_IMAGE` au moment de cette
-- migration : les changer plus haut ne doit PAS changer celles-ci, c'est tout
-- l'objet du gel.
UPDATE "databases" SET "image" = 'postgres:17-alpine'
  WHERE "image" IS NULL AND "engine" = 'postgres';--> statement-breakpoint
UPDATE "databases" SET "image" = 'redis:7-alpine'
  WHERE "image" IS NULL AND "engine" = 'redis';
