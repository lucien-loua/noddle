import {
  databases,
  envVars,
  environments,
  projects,
  serviceDependencies,
  services,
  stacks,
} from "@noddle/db/schema";
import type * as schema from "@noddle/db/schema";
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

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

export function projectsOfTeam(db: Db, teamId: string) {
  return db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.teamId, teamId));
}

export async function listProjectEnvironments(
  db: Db,
  teamId: string,
  projectId: string
) {
  return await db.query.environments.findMany({
    orderBy: environments.name,
    where: and(
      eq(environments.projectId, projectId),
      inArray(environments.projectId, projectsOfTeam(db, teamId))
    ),
  });
}

export async function environmentNameTaken(
  db: Db,
  teamId: string,
  projectId: string,
  name: string,
  exceptEnvironmentId?: string
): Promise<boolean> {
  const row = await db.query.environments.findFirst({
    columns: { id: true },
    where: and(
      eq(environments.projectId, projectId),
      inArray(environments.projectId, projectsOfTeam(db, teamId)),
      eq(environments.name, name),
      exceptEnvironmentId ? ne(environments.id, exceptEnvironmentId) : undefined
    ),
  });
  return row !== undefined;
}

export function environmentsOfTeam(db: Db, teamId: string) {
  return db
    .select({ id: environments.id })
    .from(environments)
    .where(inArray(environments.projectId, projectsOfTeam(db, teamId)));
}

export function servicesOfTeam(db: Db, teamId: string) {
  return db
    .select({ id: services.id })
    .from(services)
    .where(inArray(services.environmentId, environmentsOfTeam(db, teamId)));
}

export function databasesOfTeam(db: Db, teamId: string) {
  return db
    .select({ id: databases.id })
    .from(databases)
    .where(inArray(databases.environmentId, environmentsOfTeam(db, teamId)));
}

export interface EnvVarTargetRef {
  databaseId?: string;
  serviceId?: string;
}

export async function listEnvVars(
  db: Db,
  teamId: string,
  target: EnvVarTargetRef
) {
  const owned = target.serviceId
    ? and(
        eq(envVars.serviceId, target.serviceId),
        isNull(envVars.databaseId),
        inArray(envVars.serviceId, servicesOfTeam(db, teamId))
      )
    : and(
        eq(envVars.databaseId, target.databaseId ?? ""),
        isNull(envVars.serviceId),
        inArray(envVars.databaseId, databasesOfTeam(db, teamId))
      );
  return await db.query.envVars.findMany({
    orderBy: envVars.key,
    where: owned,
  });
}

export async function envVarAttachments(db: Db, envVarIds: string[]) {
  if (envVarIds.length === 0) {
    return [];
  }
  return await db.query.serviceDependencies.findMany({
    where: inArray(serviceDependencies.envVarId, envVarIds),
    with: { dependsOnDatabase: { with: { environment: true } } },
  });
}

export async function databaseInTeam(
  db: Db,
  teamId: string,
  databaseId: string
) {
  return await db.query.databases.findFirst({
    where: and(
      eq(databases.id, databaseId),
      inArray(databases.id, databasesOfTeam(db, teamId))
    ),
  });
}
