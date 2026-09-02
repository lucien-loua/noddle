import { boolean, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { createdAt, updatedAt } from "#schema/columns";

export const s3Destinations = pgTable(
  "s3_destinations",
  {
    accessKeyId: text("access_key_id").notNull(),
    bucket: text("bucket").notNull(),
    createdAt,

    endpoint: text("endpoint").notNull(),

    forcePathStyle: boolean("force_path_style").notNull().default(true),
    id: uuid("id").primaryKey().defaultRandom(),

    name: text("name").notNull(),

    prefix: text("prefix").notNull().default(""),

    region: text("region").notNull().default("us-east-1"),
    secretAccessKeyEncrypted: text("secret_access_key_encrypted").notNull(),
    updatedAt,
  },
  (t) => [uniqueIndex("s3_destinations_name_idx").on(t.name)]
);
