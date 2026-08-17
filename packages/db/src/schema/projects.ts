import { sql } from "drizzle-orm";
import { boolean, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { createdAt, updatedAt } from "#schema/columns";

export const projects = pgTable(
  "projects",
  {
    createdAt,
    /** Optional, like an environment's: a project is already understood
     *  by its name. */
    description: text("description"),
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    updatedAt,
  },
  // The name is what's read in the grid AND the key of `connectRepo`'s
  // find-or-create: two "default" projects would be indistinguishable
  // there, and the second one would never be found.
  (t) => [uniqueIndex("projects_name_idx").on(t.name)]
);

export const environments = pgTable(
  "environments",
  {
    createdAt,
    /** Optional: an environment is already understood by its name. */
    description: text("description"),
    id: uuid("id").primaryKey().defaultRandom(),
    // The environment a project is born with. It cannot be deleted or
    // renamed — otherwise `/projects/<id>` would 404 with nothing to
    // redirect to. Extra environments are never the default.
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
