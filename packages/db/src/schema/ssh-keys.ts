import { pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { createdAt, updatedAt } from "#schema/columns";

export const sshKeys = pgTable(
  "ssh_keys",
  {
    createdAt,
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),

    privateKeyEncrypted: text("private_key_encrypted").notNull(),

    publicKey: text("public_key"),
    updatedAt,
  },
  (t) => [uniqueIndex("ssh_keys_name_idx").on(t.name)]
);
