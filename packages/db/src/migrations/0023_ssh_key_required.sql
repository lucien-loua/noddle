-- La clé devient obligatoire, et la colonne d'origine part.
--
-- Séparée de 0022 pour une raison mécanique : drizzle-kit demande, en INVITE
-- interactive, si une colonne ajoutée est le renommage d'une colonne
-- supprimée. Ajouter et supprimer dans la même passe rendait donc `generate`
-- impossible à lancer sans TTY. Découpé, chaque passe est sans ambiguïté et
-- l'outil produit du SQL juste.
--
-- Et l'ordre porte la sûreté : `SET NOT NULL` ne peut réussir que parce que
-- 0022 a DÉJÀ rempli `ssh_key_id` pour chaque serveur. Les deux migrations ne
-- se réordonnent pas.
--
-- La colonne d'origine part plutôt que de rester en secours : deux
-- emplacements pour la même clé, ce sont deux vérités qui divergent à la
-- première rotation.
ALTER TABLE "servers" ALTER COLUMN "ssh_key_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "servers" DROP COLUMN "ssh_private_key_encrypted";
