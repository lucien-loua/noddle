import type { createDatabase } from "@noddle/db";
import {
  databases,
  environments,
  projects,
  services,
  stacks,
} from "@noddle/db/schema";
import { and, eq, inArray, ne } from "drizzle-orm";

export type Db = ReturnType<typeof createDatabase>;

export async function listProjects(db: Db, teamId: string) {
  return await db.query.projects.findMany({
    orderBy: projects.name,
    where: eq(projects.teamId, teamId),
  });
}

export async function projectNameTaken(
  db: Db,
  teamId: string,
  name: string,
  exceptProjectId?: string
): Promise<boolean> {
  const row = await db.query.projects.findFirst({
    columns: { id: true },
    where: and(
      eq(projects.teamId, teamId),
      eq(projects.name, name),
      exceptProjectId ? ne(projects.id, exceptProjectId) : undefined
    ),
  });
  return row !== undefined;
}

export async function environmentsHold(
  db: Db,
  teamId: string,
  environmentIds: string[]
): Promise<boolean> {
  if (environmentIds.length === 0) {
    return false;
  }
  const scoped = and(
    inArray(environments.id, environmentIds),
    inArray(environments.projectId, projectsOfTeam(db, teamId))
  );
  const owned = db
    .select({ id: environments.id })
    .from(environments)
    .where(scoped);
  const [service, stack, database] = await Promise.all([
    db.query.services.findFirst({
      columns: { id: true },
      where: inArray(services.environmentId, owned),
    }),
    db.query.stacks.findFirst({
      columns: { id: true },
      where: inArray(stacks.environmentId, owned),
    }),
    db.query.databases.findFirst({
      columns: { id: true },
      where: inArray(databases.environmentId, owned),
    }),
  ]);
  return Boolean(service || stack || database);
}

function projectsOfTeam(db: Db, teamId: string) {
  return db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.teamId, teamId));
}
