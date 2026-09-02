import { sql } from "drizzle-orm";
import { boolean, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { createdAt, updatedAt } from "#schema/columns";

export const projects = pgTable(
  "projects",
  {
    createdAt,
    description: text("description"),
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    updatedAt,
  },
  (t) => [uniqueIndex("projects_name_idx").on(t.name)]
);

export const environments = pgTable(
  "environments",
  {
    createdAt,
    description: text("description"),
    id: uuid("id").primaryKey().defaultRandom(),
    isDefault: boolean("is_default").notNull().default(false),
    name: text("name").notNull(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    updatedAt,
  },
  (t) => [
    uniqueIndex("environments_project_name_idx").on(t.projectId, t.name),
    uniqueIndex("environments_one_default_idx")
      .on(t.projectId)
      .where(sql`${t.isDefault} = true`),
  ]
);
