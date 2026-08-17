import { pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { createdAt, updatedAt } from "#schema/columns";

export const registries = pgTable(
  "registries",
  {
    createdAt,
    id: uuid("id").primaryKey().defaultRandom(),
    imagePrefix: text("image_prefix").notNull().default(""),
    name: text("name").notNull(),
    passwordEncrypted: text("password_encrypted").notNull(),
    registryUrl: text("registry_url").notNull(),
    updatedAt,
    username: text("username").notNull(),
  },
  (t) => [uniqueIndex("registries_name_idx").on(t.name)],
);
