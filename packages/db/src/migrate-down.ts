import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import postgres from "postgres";

const MIGRATIONS = join(import.meta.dirname, "migrations");
const DOWN = join(MIGRATIONS, "down");
const BREAKPOINT = "--> statement-breakpoint";

interface JournalEntry {
  tag: string;
  when: number;
}

function journal(): JournalEntry[] {
  const raw = readFileSync(join(MIGRATIONS, "meta/_journal.json"), "utf-8");
  const parsed = JSON.parse(raw) as { entries: JournalEntry[] };
  return parsed.entries.toSorted((a, b) => a.when - b.when);
}

function die(message: string): never {
  process.stderr.write(`[31m✗[0m ${message}\n`);
  process.exit(1);
}

const url = process.env.DATABASE_URL;
if (!url) {
  die("DATABASE_URL is not set");
}

const sql = postgres(url, { max: 1 });

try {
  const applied = await sql<{ created_at: string }[]>`
    select created_at from drizzle.__drizzle_migrations
    order by created_at desc limit 1
  `;
  const last = applied.at(0);
  if (!last) {
    die("no migration is applied, so there is nothing to undo");
  }

  const when = Number(last.created_at);
  const entry = journal().find((row) => row.when === when);
  if (!entry) {
    die(
      `the database's newest migration (${when}) is not in the journal — this checkout does not match that database`
    );
  }

  const file = join(DOWN, `${entry.tag}.sql`);
  if (!existsSync(file)) {
    die(
      `${entry.tag} has no down migration in migrations/down. It is the initial schema, or one was never written — undoing it would mean deciding what to destroy, which is not something to infer.`
    );
  }

  const statements = readFileSync(file, "utf-8")
    .split(BREAKPOINT)
    .map((statement) => statement.trim())
    .filter(Boolean);

  process.stdout.write(`undoing ${entry.tag}\n`);
  await sql.begin(async (tx) => {
    for (const statement of statements) {
      await tx.unsafe(statement);
    }
    await tx`
      delete from drizzle.__drizzle_migrations where created_at = ${when}
    `;
  });
  process.stdout.write(`[32m✓[0m ${entry.tag} undone\n`);
} finally {
  await sql.end();
}
