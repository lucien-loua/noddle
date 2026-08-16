import { devStack } from "@noddle/testing/dev-stack";
import { defineConfig } from "drizzle-kit";

// `drizzle-kit generate` does not need a database: it compares the schema to
// the migration journal. The URL is only used by `migrate` and `studio`.
export default defineConfig({
  dbCredentials: {
    url: devStack().databaseUrl,
  },
  dialect: "postgresql",
  out: "./src/migrations",
  schema: "./src/schema/index.ts",
  strict: true,
  verbose: true,
});
