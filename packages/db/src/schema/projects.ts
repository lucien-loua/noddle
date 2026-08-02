import { pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, updatedAt } from "#schema/columns";

export const projects = pgTable("projects", {
  createdAt,
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  updatedAt,
});

export const environments = pgTable(
  "environments",
  {
    createdAt,
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    updatedAt,
  },
  (t) => [uniqueIndex("environments_project_name_idx").on(t.projectId, t.name)]
);
