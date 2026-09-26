import {
  databaseDeployments,
  databases,
  deployments,
  envVars,
  environments,
  projects,
  serviceDependencies,
  serviceDomains,
  services,
  stackDeployments,
  stacks,
} from "@noddle/db/schema";
import type * as schema from "@noddle/db/schema";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  ne,
} from "drizzle-orm";
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

export function stacksOfTeam(db: Db, teamId: string) {
  return db
    .select({ id: stacks.id })
    .from(stacks)
    .where(inArray(stacks.environmentId, environmentsOfTeam(db, teamId)));
}

export async function listServicesInContext(
  db: Db,
  teamId: string,
  environmentId?: string
) {
  return await db.query.services.findMany({
    orderBy: services.name,
    where: and(
      inArray(services.environmentId, environmentsOfTeam(db, teamId)),
      environmentId ? eq(services.environmentId, environmentId) : undefined
    ),
    with: {
      domains: { orderBy: asc(serviceDomains.createdAt) },
      environment: { with: { project: true } },
      server: true,
    },
  });
}

export async function serviceInContext(
  db: Db,
  teamId: string,
  serviceId: string
) {
  return await db.query.services.findFirst({
    where: and(
      eq(services.id, serviceId),
      inArray(services.environmentId, environmentsOfTeam(db, teamId))
    ),
    with: {
      domains: { orderBy: asc(serviceDomains.createdAt) },
      environment: { with: { project: true } },
      server: true,
    },
  });
}

export async function listStacksInContext(
  db: Db,
  teamId: string,
  environmentId?: string
) {
  return await db.query.stacks.findMany({
    orderBy: stacks.name,
    where: and(
      inArray(stacks.environmentId, environmentsOfTeam(db, teamId)),
      environmentId ? eq(stacks.environmentId, environmentId) : undefined
    ),
    with: { environment: { with: { project: true } }, server: true },
  });
}

export async function listDatabasesInContext(
  db: Db,
  teamId: string,
  environmentId?: string
) {
  return await db.query.databases.findMany({
    orderBy: databases.name,
    where: and(
      inArray(databases.environmentId, environmentsOfTeam(db, teamId)),
      environmentId ? eq(databases.environmentId, environmentId) : undefined
    ),
    with: { environment: { with: { project: true } }, server: true },
  });
}

export async function databaseInContext(
  db: Db,
  teamId: string,
  databaseId: string
) {
  return await db.query.databases.findFirst({
    where: and(
      eq(databases.id, databaseId),
      inArray(databases.environmentId, environmentsOfTeam(db, teamId))
    ),
    with: { environment: { with: { project: true } }, server: true },
  });
}

export async function environmentOfProject(
  db: Db,
  teamId: string,
  projectId: string,
  environmentId: string
) {
  return await db.query.environments.findFirst({
    where: and(
      eq(environments.id, environmentId),
      eq(environments.projectId, projectId),
      inArray(environments.projectId, projectsOfTeam(db, teamId))
    ),
    with: { project: true },
  });
}

export async function serviceDeploymentsOf(
  db: Db,
  teamId: string,
  serviceIds: string[],
  limit?: number
) {
  if (serviceIds.length === 0) {
    return [];
  }
  return await db.query.deployments.findMany({
    limit,
    orderBy: desc(deployments.createdAt),
    where: and(
      inArray(deployments.serviceId, serviceIds),
      inArray(deployments.serviceId, servicesOfTeam(db, teamId))
    ),
  });
}

export async function stackDeploymentsOf(
  db: Db,
  teamId: string,
  stackIds: string[]
) {
  if (stackIds.length === 0) {
    return [];
  }
  return await db.query.stackDeployments.findMany({
    orderBy: desc(stackDeployments.createdAt),
    where: and(
      inArray(stackDeployments.stackId, stackIds),
      inArray(stackDeployments.stackId, stacksOfTeam(db, teamId))
    ),
  });
}

export async function databaseDeploymentsOf(
  db: Db,
  teamId: string,
  databaseId: string,
  limit: number
) {
  return await db.query.databaseDeployments.findMany({
    limit,
    orderBy: desc(databaseDeployments.createdAt),
    where: and(
      eq(databaseDeployments.databaseId, databaseId),
      inArray(databaseDeployments.databaseId, databasesOfTeam(db, teamId))
    ),
  });
}

export async function recentServiceDeployments(
  db: Db,
  teamId: string,
  limit: number
) {
  return await db.query.deployments.findMany({
    limit,
    orderBy: desc(deployments.createdAt),
    where: inArray(deployments.serviceId, servicesOfTeam(db, teamId)),
    with: {
      service: {
        with: { environment: { with: { project: true } }, server: true },
      },
    },
  });
}

export async function recentStackDeployments(
  db: Db,
  teamId: string,
  limit: number
) {
  return await db.query.stackDeployments.findMany({
    limit,
    orderBy: desc(stackDeployments.createdAt),
    where: inArray(stackDeployments.stackId, stacksOfTeam(db, teamId)),
    with: {
      stack: {
        with: { environment: { with: { project: true } }, server: true },
      },
    },
  });
}

export async function teamActivityCounts(
  db: Db,
  teamId: string,
  since: Date
): Promise<{ deploys: number; environments: number; projects: number }> {
  const [deployRows, projectRows, environmentRows] = await Promise.all([
    db
      .select({ value: count() })
      .from(deployments)
      .where(
        and(
          gte(deployments.createdAt, since),
          inArray(deployments.serviceId, servicesOfTeam(db, teamId))
        )
      ),
    db
      .select({ value: count() })
      .from(projects)
      .where(eq(projects.teamId, teamId)),
    db
      .select({ value: count() })
      .from(environments)
      .where(inArray(environments.projectId, projectsOfTeam(db, teamId))),
  ]);
  return {
    deploys: deployRows[0]?.value ?? 0,
    environments: environmentRows[0]?.value ?? 0,
    projects: projectRows[0]?.value ?? 0,
  };
}

export async function findOrCreateTeamProject(
  db: Db,
  teamId: string,
  name: string
) {
  const inTeam = and(eq(projects.teamId, teamId), eq(projects.name, name));
  const existing = await db.query.projects.findFirst({ where: inTeam });
  if (existing) {
    return existing;
  }
  const [created] = await db
    .insert(projects)
    .values({ name, teamId })
    .onConflictDoNothing()
    .returning();
  const project =
    created ?? (await db.query.projects.findFirst({ where: inTeam }));
  if (!project) {
    throw new Error("could not create project");
  }
  return project;
}

export async function environmentByName(
  db: Db,
  teamId: string,
  projectId: string,
  name: string
) {
  return await db.query.environments.findFirst({
    where: and(
      eq(environments.projectId, projectId),
      inArray(environments.projectId, projectsOfTeam(db, teamId)),
      eq(environments.name, name)
    ),
  });
}

export async function serviceInTeam(
  db: Db,
  teamId: string,
  serviceId: string
): Promise<boolean> {
  const row = await db.query.services.findFirst({
    columns: { id: true },
    where: and(
      eq(services.id, serviceId),
      inArray(services.environmentId, environmentsOfTeam(db, teamId))
    ),
  });
  return row !== undefined;
}

export async function envVarOfService(
  db: Db,
  teamId: string,
  serviceId: string,
  key: string
) {
  return await db.query.envVars.findFirst({
    where: and(
      eq(envVars.serviceId, serviceId),
      inArray(envVars.serviceId, servicesOfTeam(db, teamId)),
      eq(envVars.key, key)
    ),
  });
}

export async function deploymentOfTeam(
  db: Db,
  teamId: string,
  deploymentId: string
) {
  const [service, stack, database] = await Promise.all([
    db.query.deployments.findFirst({
      columns: { status: true },
      where: and(
        eq(deployments.id, deploymentId),
        inArray(deployments.serviceId, servicesOfTeam(db, teamId))
      ),
    }),
    db.query.stackDeployments.findFirst({
      columns: { status: true },
      where: and(
        eq(stackDeployments.id, deploymentId),
        inArray(stackDeployments.stackId, stacksOfTeam(db, teamId))
      ),
    }),
    db.query.databaseDeployments.findFirst({
      columns: { status: true },
      where: and(
        eq(databaseDeployments.id, deploymentId),
        inArray(databaseDeployments.databaseId, databasesOfTeam(db, teamId))
      ),
    }),
  ]);
  return service ?? stack ?? database;
}
