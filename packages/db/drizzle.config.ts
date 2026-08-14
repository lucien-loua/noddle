import { defineConfig } from "drizzle-kit";

// `drizzle-kit generate` does not need a database: it compares the schema to
// the migration journal. The URL is only used by `migrate` and `studio`.
export default defineConfig({
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      "postgres://postgres:noddle@localhost:55432/noddle",
  },
  dialect: "postgresql",
  out: "./src/migrations",
  schema: "./src/schema/index.ts",
  strict: true,
  verbose: true,
});
