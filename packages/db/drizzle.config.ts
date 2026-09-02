import { devStack } from "@noddle/testing/dev-stack";
import { defineConfig } from "drizzle-kit";

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
