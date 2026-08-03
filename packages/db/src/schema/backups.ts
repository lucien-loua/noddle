// Sauvegardes des bases de données vers un stockage compatible S3.
//
// Deux tables, et deux décisions qu'elles portent :
//
//   backup_destinations   UNE destination par installation, garantie par la
//                         base elle-même (voir `singleton` plus bas). Le cas
//                         courant du produit est une machine, un compartiment ;
//                         demander des identifiants S3 base par base ferait
//                         payer un sélecteur sur chaque écran, pour toujours.
//                         L'ouvrir plus tard est une migration additive
//                         (`destination_id` nullable sur `databases`), la
//                         refermer ne l'est pas.
//
//   backups               l'historique, à une base ce qu'un déploiement est à
//                         un service — SAUF que restaurer DÉTRUIT les données
//                         courantes, là où un rollback d'image est réversible.
//                         D'où `kind = 'pre_restore'` : toute restauration est
//                         précédée d'une sauvegarde de sûreté, ce qui rend
//                         l'analogie vraie au lieu de seulement affirmée.

import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, updatedAt } from "#schema/columns";
import { databases } from "#schema/databases";

export const backupDestinations = pgTable(
  "backup_destinations",
  {
    // Non secret : il apparaît tel quel dans chaque requête signée.
    accessKeyId: text("access_key_id").notNull(),
    bucket: text("bucket").notNull(),
    createdAt,

    // URL complète du service S3 : `https://…r2.cloudflarestorage.com`,
    // `http://10.0.0.5:9000`. Noddle ne devine jamais de point de terminaison —
    // il n'y a pas de valeur par défaut raisonnable hors d'AWS.
    endpoint: text("endpoint").notNull(),

    // Hors AWS, `compartiment.hôte` ne résout pas — RustFS, MinIO et un R2
    // local veulent tous le style chemin. Colonne plutôt que constante parce
    // que le vrai S3 d'Amazon, lui, le refuse sur les compartiments récents.
    forcePathStyle: boolean("force_path_style").notNull().default(true),
    id: uuid("id").primaryKey().defaultRandom(),

    // Préfixe de clé, pour partager un compartiment avec autre chose.
    prefix: text("prefix").notNull().default(""),

    // Beaucoup d'implémentations s'en moquent, la signature SigV4 non : elle
    // entre dans le calcul, donc une valeur fausse fait échouer l'auth.
    region: text("region").notNull().default("us-east-1"),
    secretAccessKeyEncrypted: text("secret_access_key_encrypted").notNull(),

    // L'unicité est tenue par la BASE, pas par la couche web : les scripts de
    // vérification écrivent en SQL direct, et une deuxième destination
    // silencieuse produirait des sauvegardes réparties sur deux compartiments
    // sans que rien ne le signale.
    singleton: boolean("singleton").notNull().default(true),
    updatedAt,
  },
  (t) => [
    check("backup_destinations_singleton_true", sql`${t.singleton}`),
    uniqueIndex("backup_destinations_singleton_idx").on(t.singleton),
  ]
);

export const backupStatus = pgEnum("backup_status", [
  "queued",
  "running",
  // L'objet est dans le compartiment ET le dumper est sorti en 0. Les deux :
  // un dump tronqué se téléverse parfaitement, mesuré contre RustFS. Seul le
  // code de sortie distingue une sauvegarde d'une moitié de sauvegarde.
  "completed",
  "failed",
]);

export const backupKind = pgEnum("backup_kind", [
  "manual",
  "scheduled",
  // Prise automatiquement juste avant une restauration. C'est le filet de la
  // seule opération irréversible du produit.
  "pre_restore",
]);

export const backups = pgTable(
  "backups",
  {
    createdAt,
    databaseId: uuid("database_id")
      .notNull()
      .references(() => databases.id, { onDelete: "cascade" }),
    errorMessage: text("error_message"),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    id: uuid("id").primaryKey().defaultRandom(),
    kind: backupKind("kind").notNull().default("manual"),

    // Décidée à la création de la ligne, avant le moindre octet : sans elle on
    // ne saurait pas quoi supprimer si le job meurt entre les deux.
    objectKey: text("object_key").notNull(),

    // Relevée depuis un HEAD après coup, jamais depuis le compteur d'octets
    // du flux : c'est ce que le compartiment détient réellement.
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }),
    status: backupStatus("status").notNull().default("queued"),
  },
  (t) => [index("backups_database_created_idx").on(t.databaseId, t.createdAt)]
);
