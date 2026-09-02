import { join } from "node:path";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("required environment variable: DATABASE_URL");
}

const migrationsFolder = join(import.meta.dirname, "migrations");

const client = postgres(url, { max: 1 });

try {
  await migrate(drizzle(client), { migrationsFolder });
  process.stdout.write("migrations applied\n");
} finally {
  await client.end();
}
