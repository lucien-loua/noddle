import type { createDatabase } from "@noddle/db";
import { projects } from "@noddle/db/schema";
import { eq } from "drizzle-orm";

export type Db = ReturnType<typeof createDatabase>;

export async function listProjects(db: Db, teamId: string) {
  return await db.query.projects.findMany({
    orderBy: projects.name,
    where: eq(projects.teamId, teamId),
  });
}
