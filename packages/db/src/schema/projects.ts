import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { createdAt, updatedAt } from "#schema/columns";
import { organization } from "#schema/teams";

export const DEFAULT_TEAM_ID = "default";

export const projects = pgTable(
  "projects",
  {
    createdAt,
    description: text("description"),
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    teamId: text("team_id")
      .notNull()
      .default(DEFAULT_TEAM_ID)
      .references(() => organization.id, { onDelete: "restrict" }),
    updatedAt,
  },
  (t) => [
    uniqueIndex("projects_name_idx").on(t.name),
    index("projects_team_idx").on(t.teamId),
  ]
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
