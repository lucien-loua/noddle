// Colonnes présentes sur presque toutes les tables.
//
// Définies une fois : `timestamp(...)` renvoie un constructeur de colonne
// réutilisable, et le recopier table par table finit toujours par produire un
// `withTimezone` oublié quelque part.
import { timestamp } from "drizzle-orm/pg-core";

export const createdAt = timestamp("created_at", { withTimezone: true })
  .notNull()
  .defaultNow();

export const updatedAt = timestamp("updated_at", { withTimezone: true })
  .notNull()
  .defaultNow();
