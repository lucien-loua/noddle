import { sql } from "drizzle-orm";
import { check, pgTable, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { createdAt } from "#schema/columns";
import { databases } from "#schema/databases";
import { services } from "#schema/services";

/**
 * What a service consumes: a Database, or another Service over the overlay
 * network.
 *
 * DECLARED, never inferred. The link exists today only inside a
 * `DATABASE_URL`, encrypted at rest — deriving the graph would mean
 * decrypting every value of every service to read it, and a wrong guess
 * would be silent. A topology that lies is worse than no topology.
 *
 * The edge does not order deploys, and ADR-0021 says why.
 *
 * Two nullable target columns and a `check`, exactly like `env_vars`: one
 * table, one set of cascades, and no row that belongs to nothing.
 */
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
    id: uuid("id").primaryKey().defaultRandom(),
    serviceId: uuid("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
  },
  (t) => [
    // PARTIAL, same trap as `env_vars`: an ordinary unique index counts two
    // NULLs as distinct, so one pair could be declared any number of times.
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
