import { boolean, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, updatedAt } from "#schema/columns";
import { services } from "#schema/services";

export const envVars = pgTable(
  "env_vars",
  {
    createdAt,
    id: uuid("id").primaryKey().defaultRandom(),

    // Pilote l'affichage (masquée dans l'UI) et l'injection : préférer
    // `docker secret` pour que rien ne fuite dans `docker inspect`.
    isSecret: boolean("is_secret").notNull().default(false),
    key: text("key").notNull(),
    serviceId: uuid("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    updatedAt,

    // Chiffré au repos, systématiquement — y compris pour les valeurs non
    // secrètes. Un seul chemin de code, donc aucun risque d'oubli.
    valueEncrypted: text("value_encrypted").notNull(),
  },
  (t) => [uniqueIndex("env_vars_service_key_idx").on(t.serviceId, t.key)]
);
