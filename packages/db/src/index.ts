import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
// Drizzle's relational API requires the full schema object; listing tables one
// by one would desync from the folder on every addition.
// biome-ignore lint/performance/noNamespaceImport: required by drizzle({ schema })
import * as schema from "#schema/index";

export type Database = ReturnType<typeof createDatabase>;

export interface DatabaseOptions {
  /**
   * The worker and the web app each open their own pool. The worker handles
   * long jobs (minutes): a few connections are enough, and keeping too many
   * open on a 2 GB VM takes space Postgres does not have.
   */
  maxConnections?: number;
  url: string;
}

export function createDatabase(opts: DatabaseOptions) {
  const client = postgres(opts.url, { max: opts.maxConnections ?? 5 });
  return drizzle(client, { schema });
}
