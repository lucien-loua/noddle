// Canaux de notification : où Noddle prévient quand quelque chose va mal.
//
// Plusieurs canaux sont permis, contrairement à la destination de sauvegarde
// qui est unique. La raison qui imposait l'unicité là-bas — un sélecteur à
// poser sur chaque écran — ne s'applique pas ici : c'est une liste dans un
// écran de réglages, et envoyer à la fois sur Discord et sur un webhook maison
// est un cas réel, pas une hypothèse.
//
// Ce qui est notifié, c'est ce qui va MAL. Un canal qui se déclenche à chaque
// succès entraîne les gens à l'ignorer, et le jour où il compte personne ne le
// lit. Le seul désaccord réel — être prévenu des déploiements réussis — est
// une case à cocher, décochée par défaut.
import {
  boolean,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, updatedAt } from "#schema/columns";

/**
 * Le même mécanisme d'envoi pour les trois : un POST JSON. Seule la FORME de
 * la charge utile change, parce que Discord et Slack imposent chacun la leur.
 * `webhook` est la forme brute de Noddle, celle qu'on branche sur n'importe
 * quoi d'autre.
 */
export const notificationKind = pgEnum("notification_kind", [
  "webhook",
  "discord",
  "slack",
]);

export const notificationChannels = pgTable("notification_channels", {
  createdAt,
  /** Coupé sans être supprimé : on garde l'URL et l'historique d'erreur. */
  enabled: boolean("enabled").notNull().default(true),
  id: uuid("id").primaryKey().defaultRandom(),
  kind: notificationKind("kind").notNull(),

  /**
   * La dernière erreur d'envoi, et la dernière réussite.
   *
   * C'est le cœur du sujet, pas un ornement : une notification qui échoue en
   * SILENCE est pire que pas de notification du tout — on se croit surveillé.
   * Ces deux colonnes sont ce qui permet à l'écran de dire « ce canal n'a
   * rien envoyé depuis trois jours » au lieu de laisser croire au calme plat.
   */
  lastError: text("last_error"),
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),

  name: text("name").notNull(),

  /**
   * Décochée par défaut. Prévenir de chaque déploiement réussi est le moyen le
   * plus sûr de rendre le canal invisible le jour où il porte un échec.
   */
  notifySuccess: boolean("notify_success").notNull().default(false),

  updatedAt,

  /**
   * Chiffrée au repos : une URL de webhook Discord ou Slack EST un secret —
   * qui la détient peut écrire dans le salon. La règle est déjà posée dans
   * CLAUDE.md pour les clés SSH et les variables d'environnement.
   */
  urlEncrypted: text("url_encrypted").notNull(),
});
