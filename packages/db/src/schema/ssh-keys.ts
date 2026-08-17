import { pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { createdAt, updatedAt } from "#schema/columns";

export const sshKeys = pgTable(
  "ssh_keys",
  {
    createdAt,
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),

    /**
     * AES-256-GCM, as everywhere else. NEVER return it via a server
     * function, even encrypted.
     *
     * A model observed elsewhere stores its own in plaintext
     * (`privateKey: text().notNull()`) and returns it as-is from the read
     * endpoints — their redaction only covers the "server" path. That's
     * the underlying reason this model wasn't copied.
     */
    privateKeyEncrypted: text("private_key_encrypted").notNull(),

    /**
     * The PUBLIC part, in plaintext and in the form `authorized_keys`
     * expects.
     *
     * Nullable for a single reason, and it's historical: keys carried over
     * from `servers.ssh_private_key_encrypted` by the migration don't have
     * one. We can't derive it in SQL — that would require decrypting, so
     * APP_KEY and AES-GCM — and inventing an empty string would make it
     * pass for a valid public key. A gap stays a gap, here too.
     */
    publicKey: text("public_key"),
    updatedAt,
  },
  // The name is what's read in the selector of the add form: two "default"
  // keys would be indistinguishable there.
  (t) => [uniqueIndex("ssh_keys_name_idx").on(t.name)],
);
