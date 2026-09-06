import { decryptSecret, encryptSecret, loadAppKey } from "@noddle/crypto";
import postgres from "postgres";

import { ENCRYPTED_COLUMNS } from "#encrypted-columns";

function die(message: string): never {
  process.stderr.write(`[31m✗[0m ${message}\n`);
  process.exit(1);
}

const url = process.env.DATABASE_URL;
const from = process.env.APP_KEY;
const to = process.env.NEW_APP_KEY;

if (!url) {
  die("DATABASE_URL is not set");
}
if (!(from && to)) {
  die(
    "APP_KEY (the current one) and NEW_APP_KEY (the replacement) must both be set"
  );
}
if (from === to) {
  die("NEW_APP_KEY is the same as APP_KEY, so there is nothing to rotate");
}

const oldKey = loadAppKey(from);
const newKey = loadAppKey(to);

const sql = postgres(url, { max: 1 });
let rewritten = 0;

try {
  await sql.begin(async (tx) => {
    for (const entry of ENCRYPTED_COLUMNS) {
      const rows = await tx.unsafe(
        `select "${entry.id}" as id, "${entry.column}" as secret
         from "${entry.table}" where "${entry.column}" is not null`
      );

      for (const row of rows as unknown as { id: string; secret: string }[]) {
        const context = entry.context(row.id);
        const plaintext = decryptSecret(row.secret, oldKey, context);
        const reencrypted = encryptSecret(plaintext, newKey, context);
        await tx.unsafe(
          `update "${entry.table}" set "${entry.column}" = $1 where "${entry.id}" = $2`,
          [reencrypted, row.id]
        );
        rewritten += 1;
      }

      if (rows.length > 0) {
        process.stdout.write(
          `  ${entry.table}.${entry.column}: ${rows.length}\n`
        );
      }
    }
  });
} catch (error) {
  await sql.end();
  die(
    `nothing was changed. ${error instanceof Error ? error.message : String(error)}`
  );
}

await sql.end();
process.stdout.write(
  `[32m✓[0m ${rewritten} secret(s) re-encrypted. Put NEW_APP_KEY in installer/.env as APP_KEY and restart, or every one of them becomes unreadable.\n`
);
