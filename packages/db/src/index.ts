import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
// L'API relationnelle de Drizzle exige l'objet schéma complet ; l'énumérer
// table par table le désynchroniserait du dossier à chaque ajout.
// biome-ignore lint/performance/noNamespaceImport: exigé par drizzle({ schema })
import * as schema from "#schema/index";

export type Database = ReturnType<typeof createDatabase>;

export interface DatabaseOptions {
  /**
   * Le worker et l'app web ouvrent chacun leur pool. Le worker traite des jobs
   * longs (des minutes) : quelques connexions suffisent, et en garder trop
   * ouvertes sur une VM à 2 Go prend de la place que Postgres n'a pas.
   */
  maxConnections?: number;
  url: string;
}

export function createDatabase(opts: DatabaseOptions) {
  const client = postgres(opts.url, { max: opts.maxConnections ?? 5 });
  return drizzle(client, { schema });
}
