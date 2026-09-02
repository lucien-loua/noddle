import { sql } from "drizzle-orm";
import { check, pgTable, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { createdAt } from "#schema/columns";
import { databases } from "#schema/databases";
import { envVars } from "#schema/env-vars";
import { services } from "#schema/services";

export const serviceDependencies = pgTable(
  "service_dependencies",
  {
    createdAt,
    dependsOnDatabaseId: uuid("depends_on_database_id").references(
      () => databases.id,
      { onDelete: "cascade" }
    ),
    dependsOnServiceId: uuid("depends_on_service_id").references(
      () => services.id,
      { onDelete: "cascade" }
    ),
    envVarId: uuid("env_var_id").references(() => envVars.id, {
      onDelete: "set null",
    }),
    id: uuid("id").primaryKey().defaultRandom(),
    serviceId: uuid("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
  },
  (t) => [
    uniqueIndex("service_dependencies_database_idx")
      .on(t.serviceId, t.dependsOnDatabaseId)
      .where(sql`${t.dependsOnDatabaseId} is not null`),
    uniqueIndex("service_dependencies_service_idx")
      .on(t.serviceId, t.dependsOnServiceId)
      .where(sql`${t.dependsOnServiceId} is not null`),
    check(
      "service_dependencies_one_target",
      sql`(${t.dependsOnServiceId} is null) <> (${t.dependsOnDatabaseId} is null)`
    ),
    check(
      "service_dependencies_no_self",
      sql`${t.dependsOnServiceId} is distinct from ${t.serviceId}`
    ),
  ]
);
