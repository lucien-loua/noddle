// tier: pure
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { check, runVerify } from "@noddle/testing";

const MIGRATIONS = join(import.meta.dirname, "migrations");
const DOWN = join(MIGRATIONS, "down");
const INITIAL = "0000_init.sql";

const UNSAFE = [
  {
    name: "dropped column",
    pattern: /\bDROP\s+COLUMN\b/i,
    why: "a rolled-back image still writes that column, so its INSERTs fail",
  },
  {
    name: "dropped table",
    pattern: /\bDROP\s+TABLE\b/i,
    why: "a rolled-back image still reads that table",
  },
  {
    name: "rename",
    pattern: /\bRENAME\s+(COLUMN|TO)\b/i,
    why: "a rolled-back image knows the old name and nothing answers to it",
  },
  {
    name: "column made NOT NULL",
    pattern: /\bSET\s+NOT\s+NULL\b/i,
    why: "a rolled-back image omits the column on insert and the row is refused",
  },
  {
    name: "changed column type",
    pattern: /\bALTER\s+COLUMN\b[^;]*\bTYPE\b/i,
    why: "a rolled-back image writes the old type",
  },
] as const;

const STATEMENT_BREAKPOINT = "--> statement-breakpoint";

await runVerify("migrations keep a rollback safe", () => {
  const files = readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith(".sql"))
    .toSorted();

  check(
    "there are migrations to check",
    files.length > 0,
    String(files.length)
  );

  const downs = new Set(readdirSync(DOWN));

  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS, file), "utf-8");

    if (file !== INITIAL) {
      check(
        `${file} has a down migration beside it`,
        downs.has(file),
        "migrations/down is what makes a rollback reversible; without it the schema only moves forward"
      );
    }

    for (const { name, pattern, why } of UNSAFE) {
      const found = pattern.exec(sql);
      check(
        `${file}: no ${name}`,
        found === null,
        found ? `${found[0]} — ${why}` : undefined
      );
    }

    if (sql.includes(";") && sql.trim().split(";").length > 2) {
      check(
        `${file} separates its statements for drizzle's migrator`,
        sql.includes(STATEMENT_BREAKPOINT),
        "a file with several statements collapses into one without it"
      );
    }
  }
});
