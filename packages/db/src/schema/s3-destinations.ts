import { boolean, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { createdAt, updatedAt } from "#schema/columns";

export const s3Destinations = pgTable(
  "s3_destinations",
  {
    // Not secret: it appears as-is in every signed request.
    accessKeyId: text("access_key_id").notNull(),
    bucket: text("bucket").notNull(),
    createdAt,

    // Full URL of the S3 service: `https://…r2.cloudflarestorage.com`,
    // `http://10.0.0.5:9000`. Noddle never guesses an endpoint — there's
    // no sensible default outside of AWS.
    endpoint: text("endpoint").notNull(),

    // Outside AWS, `bucket.host` doesn't resolve — RustFS, MinIO and a
    // local R2 all want path style. A column rather than a constant
    // because real AWS S3, on the other hand, refuses it on recent
    // buckets.
    forcePathStyle: boolean("force_path_style").notNull().default(true),
    id: uuid("id").primaryKey().defaultRandom(),

    // What distinguishes two buckets at a glance. Required: without it, a
    // selector would only have URLs to offer.
    name: text("name").notNull(),

    // Key prefix, for sharing a bucket with something else.
    prefix: text("prefix").notNull().default(""),

    // Plenty of implementations don't care, but SigV4 signing does: it
    // enters into the computation, so a wrong value makes auth fail.
    region: text("region").notNull().default("us-east-1"),
    secretAccessKeyEncrypted: text("secret_access_key_encrypted").notNull(),
    updatedAt,
  },
  (t) => [uniqueIndex("s3_destinations_name_idx").on(t.name)]
);
