// tier: local
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { createDatabase } from "@noddle/db";
import { check, runVerify } from "@noddle/testing";
import { devStack } from "@noddle/testing/dev-stack";
import { sql } from "drizzle-orm";

const url = devStack().databaseUrl.replace("localhost", "127.0.0.1");

await runVerify("schema drift (the database vs the migrations)", async () => {
  const db = createDatabase({ url });

  const migrations = join(
    import.meta.dirname,
    "../../../packages/db/src/migrations"
  );
  const sqlText = readdirSync(migrations)
    .filter((file) => file.endsWith(".sql"))
    .map((file) => readFileSync(join(migrations, file), "utf-8"))
    .join("\n");

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
