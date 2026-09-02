import {
  boolean,
  index,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { createdAt, updatedAt } from "#schema/columns";
import { services } from "#schema/services";

export const certificateType = pgEnum("certificate_type", [
  "none",
  "letsencrypt",
]);

export const serviceDomains = pgTable(
  "service_domains",
  {
    certificateType: certificateType("certificate_type")
      .notNull()
      .default("none"),
    createdAt,
    host: text("host").notNull(),
    https: boolean("https").notNull().default(false),
    id: uuid("id").primaryKey().defaultRandom(),
    internalPath: text("internal_path"),
    path: text("path").notNull().default("/"),
    serviceId: uuid("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    stripPath: boolean("strip_path").notNull().default(false),
    updatedAt,
  },
  (t) => [
    index("service_domains_service_idx").on(t.serviceId),
    uniqueIndex("service_domains_host_idx").on(t.host),
    uniqueIndex("service_domains_service_host_idx").on(t.serviceId, t.host),
  ]
);
