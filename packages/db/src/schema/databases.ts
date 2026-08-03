// Base de données en un clic : un conteneur officiel (Postgres, Redis…),
// un volume nommé, épinglé au serveur qui le porte — Swarm ne résout pas le
// stockage distribué, la donnée vit sur UN nœud, explicitement (voir
// CLAUDE.md).
//
// Pas d'historique de déploiement ici, contrairement à `services`/`stacks` :
// une base n'a qu'UNE version en cours, jamais une pile de versions
// antérieures vers lesquelles revenir. La politique de redémarrage de Swarm
// suffit pour un crash isolé ; il n'y a rien d'autre à surveiller.
import { pgEnum, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, updatedAt } from "#schema/columns";
import { environments } from "#schema/projects";
import { servers } from "#schema/servers";
import { serviceStatus } from "#schema/services";

export const databaseEngine = pgEnum("database_engine", ["postgres", "redis"]);

export const databases = pgTable(
  "databases",
  {
    createdAt,
    engine: databaseEngine("engine").notNull(),
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),

    // Jamais renvoyé au navigateur, même chiffré, même une fois. Attacher
    // une base à un service écrit directement une variable d'environnement
    // CHIFFRÉE côté serveur — le mot de passe ne traverse jamais le réseau
    // vers le client, contrairement au secret d'un webhook qu'il faut bien
    // faire sortir vers un tiers.
    rootPasswordEncrypted: text("root_password_encrypted").notNull(),

    // Absent pour redis, qui n'a pas de notion d'utilisateur — seulement un
    // mot de passe.
    rootUser: text("root_user"),

    // Comme `services.serverId` : le volume nommé n'existe que sur CE nœud,
    // le lien est structurel, pas un simple placement.
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "restrict" }),
    status: serviceStatus("status").notNull().default("created"),
    updatedAt,
  },
  (t) => [uniqueIndex("databases_env_name_idx").on(t.environmentId, t.name)]
);
