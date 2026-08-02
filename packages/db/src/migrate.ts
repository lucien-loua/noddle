// Application des migrations au démarrage d'une installation.
//
// Utilise le migrateur de drizzle-orm, PAS `drizzle-kit migrate` : drizzle-kit
// est un outil de développement, et l'embarquer dans une image de production
// y ferait entrer toute sa chaîne de compilation pour lire un dossier de
// fichiers .sql.
//
//   DATABASE_URL=… bun run src/migrate.ts
//
// Idempotent : drizzle tient sa propre table de journal et ne rejoue rien.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("variable d'environnement requise : DATABASE_URL");
}

// Le dossier de migrations voyage avec ce fichier, donc il se résout par
// rapport à lui — pas par rapport au répertoire courant, qui dépend de qui
// lance la commande.
const migrationsFolder = join(
  dirname(fileURLToPath(import.meta.url)),
  "migrations"
);

// Une seule connexion, fermée tout de suite : ce processus ne sert qu'à ça.
// `max: 1` évite aussi que deux migrations concurrentes se croisent si un
// redémarrage relance le conteneur pendant l'opération.
const client = postgres(url, { max: 1 });

try {
  await migrate(drizzle(client), { migrationsFolder });
  process.stdout.write("migrations appliquées\n");
} finally {
  await client.end();
}
