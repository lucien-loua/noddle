// tier: local
// Prerequisites: the dev stack is up (`docker compose -f compose.dev.yml up -d`).
// bun run apps/web/src/verify-schema-drift.ts
import { createDatabase } from "@noddle/db";
import { check, runVerify } from "@noddle/testing";
import { devStack } from "@noddle/testing/dev-stack";
import { sql } from "drizzle-orm";

/**
 * The live schema against the migrations that are supposed to describe it.
 *
 * Applying a migration is not undone by `git checkout`: the FILE goes, the
 * `ALTER TABLE` stays. A column with nothing left to explain it then breaks
 * inserts, and the failure surfaces far from its cause — it cost an hour on
 * 2026-08-21, where an abandoned `services.swarm_name` made creating any
 * application fail while every migration file looked correct.
 *
 * So this asks the DATABASE what it has, and requires every NOT NULL column
 * without a default to be named by some migration. That is exactly the shape
 * an orphan takes: nullable leftovers are harmless, a required one is not.
 */
const url = devStack().databaseUrl.replace("localhost", "127.0.0.1");

await runVerify("schema drift (the database vs the migrations)", async () => {
  const db = createDatabase({ url });

  const sqlText = await Bun.$`cat packages/db/src/migrations/*.sql`.text();

  const required = await db.execute(sql`
    select table_name, column_name
    from information_schema.columns
    where table_schema = 'public'
      and is_nullable = 'NO'
      and column_default is null
    order by table_name, column_name
  `);

  const orphans = required.filter(
    (row) => !sqlText.includes(`"${row.column_name as string}"`)
  );

  check(
    `every required column is named by a migration${
      orphans.length > 0
        ? ` — ORPHANS: ${orphans
            .map((o) => `${o.table_name}.${o.column_name}`)
            .join(", ")}`
        : ""
    }`,
    orphans.length === 0
  );

  await db.$client.end();
});
