// tier: pure
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { check, runVerify } from "@noddle/testing";

import { ENCRYPTED_COLUMNS } from "#encrypted-columns";

const SCHEMA = join(import.meta.dirname, "schema");

const COLUMN = /text\("([a-z0-9_]+_encrypted)"\)/g;
const TABLE = /pgTable\(\s*"([a-z0-9_]+)"/g;

interface Declared {
  column: string;
  file: string;
}

function declaredInSchema(): Declared[] {
  const out: Declared[] = [];
  for (const file of readdirSync(SCHEMA).filter((f) => f.endsWith(".ts"))) {
    const src = readFileSync(join(SCHEMA, file), "utf-8");
    for (const match of src.matchAll(COLUMN)) {
      if (match[1]) {
        out.push({ column: match[1], file });
      }
    }
  }
  return out;
}

await runVerify("every encrypted column is known to the rotation", () => {
  const declared = declaredInSchema();
  check(
    "the schema declares encrypted columns at all",
    declared.length > 0,
    String(declared.length)
  );

  const known = new Set(ENCRYPTED_COLUMNS.map((entry) => entry.column));
  const missing = declared.filter((entry) => !known.has(entry.column));
  check(
    "no encrypted column in the schema is absent from ENCRYPTED_COLUMNS",
    missing.length === 0,
    missing.map((m) => `${m.file}:${m.column}`).join(", ")
  );

  const tables = new Set<string>();
  for (const file of readdirSync(SCHEMA).filter((f) => f.endsWith(".ts"))) {
    const src = readFileSync(join(SCHEMA, file), "utf-8");
    for (const match of src.matchAll(TABLE)) {
      if (match[1]) {
        tables.add(match[1]);
      }
    }
  }
  const unknownTables = ENCRYPTED_COLUMNS.filter(
    (entry) => !tables.has(entry.table)
  );
  check(
    "every table the rotation names exists in the schema",
    unknownTables.length === 0,
    unknownTables.map((entry) => entry.table).join(", ")
  );

  const pairs = ENCRYPTED_COLUMNS.map(
    (entry) => `${entry.table}.${entry.column}`
  );
  check(
    "no column is listed twice — it would be re-encrypted twice",
    new Set(pairs).size === pairs.length
  );

  for (const entry of ENCRYPTED_COLUMNS) {
    check(
      `${entry.table}.${entry.column} produces a context`,
      typeof entry.context("11111111-1111-4111-8111-111111111111").aad ===
        "string"
    );
  }
});
