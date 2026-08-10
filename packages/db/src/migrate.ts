// DATABASE_URL=… bun run src/migrate.ts
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("required environment variable: DATABASE_URL");
}

// The migrations folder travels with this file, so it resolves relative to it
// — not relative to the current working directory, which depends on who runs
// the command.
const migrationsFolder = join(
  dirname(fileURLToPath(import.meta.url)),
  "migrations"
);

// A single connection, closed immediately: this process only exists for that.
// `max: 1` also avoids two concurrent migrations crossing if a restart
// relaunches the container mid-operation.
const client = postgres(url, { max: 1 });

try {
  await migrate(drizzle(client), { migrationsFolder });
  process.stdout.write("migrations applied\n");
} finally {
  await client.end();
}
