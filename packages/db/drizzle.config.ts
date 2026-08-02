import { defineConfig } from "drizzle-kit";

// `drizzle-kit generate` n'a pas besoin de base : il compare le schéma au
// journal des migrations. L'URL ne sert qu'à `migrate` et `studio`.
export default defineConfig({
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://localhost:5432/noddle",
  },
  dialect: "postgresql",
  out: "./migrations",
  schema: "./src/schema.ts",
  strict: true,
  verbose: true,
});
