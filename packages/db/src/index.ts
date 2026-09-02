import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "#schema/index";

export type Database = ReturnType<typeof createDatabase>;

export interface DatabaseOptions {
  maxConnections?: number;
  url: string;
}

export function createDatabase(opts: DatabaseOptions) {
  const client = postgres(opts.url, { max: opts.maxConnections ?? 5 });
  return drizzle(client, { schema });
}
