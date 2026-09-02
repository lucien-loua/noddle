import {
  databaseDeployments,
  deployments,
  environments,
  projects,
  serviceDomains,
  services,
  stackDeployments,
  stacks,
} from "@noddle/db/schema";
import { createServerFn } from "@tanstack/react-start";
import { and, asc, count, desc, eq, gte, inArray } from "drizzle-orm";
import z from "zod";

import { loadDatabaseDashboardRows } from "@/lib/database-rows.server";
import { db } from "@/lib/db.server";
import { requireSession } from "@/lib/session.server";
import type { DatabaseRow } from "@/server/databases/read";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export interface DeploymentSummary {
  commitSha: string | null;
  createdAt: string;
  finishedAt: string | null;
  id: string;
  imagePurged: boolean;
  imageTag: string | null;
  nodeName: string | null;
  status: string;
  trigger: string;
}

export interface ServiceDomainRow {
  certificateType: "none" | "letsencrypt";
  host: string;
  https: boolean;
  id: string;
  internalPath: string | null;
  path: string;
  stripPath: boolean;
  updatedAt: string;
}

export interface ServiceRow {
  autoDeploy: boolean;
  buildMethod: "railpack" | "dockerfile" | "image";
  buildPath: string | null;
  cleanCache: boolean;
  deployKeyId: string | null;
  displayName: string | null;
  dockerImage: string | null;
  domains: ServiceDomainRow[];
  environment: string;
  environmentId: string;
  gitBranch: string | null;
  gitProviderId: string | null;
  gitRepoFullName: string | null;
  gitRepoUrl: string | null;
  gitSubmodules: boolean;
  hookError: string | null;
  id: string;
  lastDeployment: DeploymentSummary | null;
  lastError: string | null;
  name: string;
  port: number;
  prNumber: number | null;
  project: string;
  projectId: string;
  publishDirectory: string | null;
  registryId: string | null;
  serverHost: string;
  serverName: string;
  sourceType: "git" | "github" | "gitlab" | "docker_image" | "compose";
  status: string;
  updatedAt: string;
  watching: boolean;
  watchPaths: string[];
}

export interface StackRow {
  displayName: string | null;
  domain: string | null;
  environment: string;
  environmentId: string;
  gitBranch: string;
  gitRepoUrl: string;
  id: string;
  lastDeployment: DeploymentSummary | null;
  lastError: string | null;
  name: string;
  port: number | null;
  project: string;
  projectId: string;
  publicService: string | null;
  serverName: string;
  status: string;
  updatedAt: string;
  watching: boolean;
}

async function nodeNames(): Promise<Map<string, string>> {
  const rows = await db.query.servers.findMany();
  const byNode = new Map<string, string>();
  for (const s of rows) {
    if (s.swarmNodeId) {
      byNode.set(s.swarmNodeId, s.name);
    }
  }
  return byNode;
}

function toSummary(
  row: typeof deployments.$inferSelect,
  nodes: Map<string, string>
): DeploymentSummary {
  return {
    commitSha: row.commitSha,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    id: row.id,
    imagePurged: row.imagePurged,
    imageTag: row.imageTag,
    nodeName: row.nodeId ? (nodes.get(row.nodeId) ?? null) : null,
    status: row.status,
    trigger: row.trigger,
  };
}

interface ServiceJoined {
  autoDeploy: boolean;
  buildMethod: "railpack" | "dockerfile" | "image";
  buildPath: string | null;
  cleanCache: boolean;
  deployKeyId: string | null;
  displayName: string | null;
  dockerImage: string | null;
  domains: {
    certificateType: "none" | "letsencrypt";
    host: string;
    https: boolean;
    id: string;
    internalPath: string | null;
    path: string;
    stripPath: boolean;
    updatedAt: Date;
  }[];
  environment: { name: string; project: { name: string }; projectId: string };
  environmentId: string;
  gitBranch: string | null;
  gitProviderId: string | null;
  gitRepoFullName: string | null;
  gitRepoUrl: string | null;
  gitSubmodules: boolean;
  id: string;
  lastError: string | null;
  name: string;
  port: number;
  prNumber: number | null;
  publishDirectory: string | null;
  registryId: string | null;
  server: { host: string; name: string };
  sourceType: "git" | "github" | "gitlab" | "docker_image" | "compose";
  status: string;
  updatedAt: Date;
  watchPaths: string[];
}

function toServiceRow(
  service: ServiceJoined,
  last: typeof deployments.$inferSelect | undefined,
  nodes: Map<string, string>,
  watching: boolean,
  hookError: string | null = null
): ServiceRow {
  return {
    autoDeploy: service.autoDeploy,
    buildMethod: service.buildMethod,
    buildPath: service.buildPath,
    cleanCache: service.cleanCache,
    deployKeyId: service.deployKeyId,
    dockerImage: service.dockerImage,
    domains: service.domains.map((d) => ({
      certificateType: d.certificateType,
      host: d.host,
      https: d.https,
      id: d.id,
      internalPath: d.internalPath,
      path: d.path,
      stripPath: d.stripPath,
      updatedAt: d.updatedAt.toISOString(),
    })),
    environment: service.environment.name,
    environmentId: service.environmentId,
    gitBranch: service.gitBranch,
    gitProviderId: service.gitProviderId,
    gitRepoFullName: service.gitRepoFullName,
    gitRepoUrl: service.gitRepoUrl,
    gitSubmodules: service.gitSubmodules,
    hookError,
    id: service.id,
    lastDeployment: last ? toSummary(last, nodes) : null,
    displayName: service.displayName,
    lastError: service.lastError,
    name: service.name,
    port: service.port,
    prNumber: service.prNumber,
    project: service.environment.project.name,
    projectId: service.environment.projectId,
    publishDirectory: service.publishDirectory,
    registryId: service.registryId,
    serverHost: service.server.host,
    serverName: service.server.name,
    sourceType: service.sourceType,
    status: service.status,
    updatedAt: service.updatedAt.toISOString(),
    watchPaths: service.watchPaths,
    watching,
  };
}

function toStackSummary(
  row: typeof stackDeployments.$inferSelect
): DeploymentSummary {
  return {
    commitSha: row.commitSha,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    id: row.id,
    imagePurged: false,
    imageTag: row.composeSource ? row.id : null,
    nodeName: null,
    status: row.status,
    trigger: row.trigger,
  };
}

async function hookErrors(): Promise<Map<string, string>> {
  const rows = await db.query.gitlabRepositoryHooks.findMany();
  const byKey = new Map<string, string>();
  for (const h of rows) {
    if (h.lastError) {
      byKey.set(`${h.gitProviderId}:${h.repositoryFullName}`, h.lastError);
    }
  }
  return byKey;
}

function hookErrorOf(
  errors: Map<string, string>,
  service: { gitProviderId: string | null; gitRepoFullName: string | null }
): string | null {
  return service.gitProviderId && service.gitRepoFullName
    ? (errors.get(`${service.gitProviderId}:${service.gitRepoFullName}`) ??
        null)
    : null;
}

async function loadServiceDashboard(
  environmentId?: string
): Promise<ServiceRow[]> {
  const rows = await db.query.services.findMany({
    orderBy: services.name,
    where: environmentId
      ? eq(services.environmentId, environmentId)
      : undefined,
    with: {
      domains: { orderBy: asc(serviceDomains.createdAt) },
      environment: { with: { project: true } },
      server: true,
    },
  });
  if (rows.length === 0) {
    return [];
  }

  const [recent, nodes] = await Promise.all([
    db.query.deployments.findMany({
      orderBy: desc(deployments.createdAt),
      where: inArray(
        deployments.serviceId,
        rows.map((r) => r.id)
      ),
    }),
    nodeNames(),
  ]);
  const latest = new Map<string, typeof deployments.$inferSelect>();
  const now = Date.now();
  const watched = new Set<string>();
  for (const dep of recent) {
    if (!latest.has(dep.serviceId)) {
      latest.set(dep.serviceId, dep);
    }
    if (dep.watchUntil && dep.watchUntil.getTime() > now) {
      watched.add(dep.serviceId);
    }
  }

  const errors = await hookErrors();
  return rows.map((service) =>
    toServiceRow(
      service,
      latest.get(service.id),
      nodes,
      watched.has(service.id),
      hookErrorOf(errors, service)
    )
  );
}

export const getDashboard = createServerFn({ method: "GET" }).handler(
  async (): Promise<ServiceRow[]> => {
    await requireSession();
    return loadServiceDashboard();
  }
);

export const getService = createServerFn({ method: "GET" })
  .validator((data: { serviceId: string }) => data)
  .handler(async ({ data }): Promise<ServiceRow | null> => {
    await requireSession();
    const row = await db.query.services.findFirst({
      where: eq(services.id, data.serviceId),
      with: {
        domains: { orderBy: asc(serviceDomains.createdAt) },
        environment: { with: { project: true } },
        server: true,
      },
    });
    if (!row) {
      return null;
    }

    const [last, nodes] = await Promise.all([
      db.query.deployments.findFirst({
        orderBy: desc(deployments.createdAt),
        where: eq(deployments.serviceId, row.id),
      }),
      nodeNames(),
    ]);
    const watching = Boolean(
      last?.watchUntil && last.watchUntil.getTime() > Date.now()
    );
    return toServiceRow(
      row,
      last ?? undefined,
      nodes,
      watching,
      hookErrorOf(await hookErrors(), row)
    );
  });

async function loadStackDashboard(environmentId?: string): Promise<StackRow[]> {
  const rows = await db.query.stacks.findMany({
    orderBy: stacks.name,
    where: environmentId ? eq(stacks.environmentId, environmentId) : undefined,
    with: {
      environment: { with: { project: true } },
      server: true,
    },
  });
  if (rows.length === 0) {
    return [];
  }

  const recent = await db.query.stackDeployments.findMany({
    orderBy: desc(stackDeployments.createdAt),
    where: inArray(
      stackDeployments.stackId,
      rows.map((r) => r.id)
    ),
  });

  const latest = new Map<string, typeof stackDeployments.$inferSelect>();
  const now = Date.now();
  const watched = new Set<string>();
  for (const dep of recent) {
    if (!latest.has(dep.stackId)) {
      latest.set(dep.stackId, dep);
    }
    if (dep.watchUntil && dep.watchUntil.getTime() > now) {
      watched.add(dep.stackId);
    }
  }

  return rows.map((stack) => {
    const last = latest.get(stack.id);
    return {
      displayName: stack.displayName,
      domain: stack.domain,
      environment: stack.environment.name,
      environmentId: stack.environmentId,
      gitBranch: stack.gitBranch,
      gitRepoUrl: stack.gitRepoUrl,
      id: stack.id,
      lastDeployment: last ? toStackSummary(last) : null,
      lastError: stack.lastError,
      name: stack.name,
      port: stack.port,
      project: stack.environment.project.name,
      projectId: stack.environment.projectId,
      publicService: stack.publicService,
      serverName: stack.server.name,
      status: stack.status,
      updatedAt: stack.updatedAt.toISOString(),
      watching: watched.has(stack.id),
    };
  });
}

export const getStackDashboard = createServerFn({ method: "GET" }).handler(
  async (): Promise<StackRow[]> => {
    await requireSession();
    return loadStackDashboard();
  }
);

export const getDeployments = createServerFn({ method: "GET" })
  .validator((data: { serviceId: string }) => data)
  .handler(async ({ data }): Promise<DeploymentSummary[]> => {
    await requireSession();
    const [rows, nodes] = await Promise.all([
      db.query.deployments.findMany({
        limit: 50,
        orderBy: desc(deployments.createdAt),
        where: eq(deployments.serviceId, data.serviceId),
      }),
      nodeNames(),
    ]);
    return rows.map((row) => toSummary(row, nodes));
  });

export const getDatabaseDeployments = createServerFn({ method: "GET" })
  .validator((data: { databaseId: string }) => data)
  .handler(async ({ data }): Promise<DeploymentSummary[]> => {
    await requireSession();
    const rows = await db.query.databaseDeployments.findMany({
      limit: 50,
      orderBy: desc(databaseDeployments.createdAt),
      where: eq(databaseDeployments.databaseId, data.databaseId),
    });
    return rows.map((row) => ({
      commitSha: null,
      createdAt: row.createdAt.toISOString(),
      finishedAt: row.finishedAt?.toISOString() ?? null,
      id: row.id,
      imagePurged: false,
      imageTag: row.image,
      nodeName: null,
      status: row.status,
      trigger: row.trigger,
    }));
  });

function scopeKey(project: string, environment: string): string {
  return `${project}/${environment}`;
}

export interface Scope {
  databases: DatabaseRow[];
  environment: string;
  environmentId: string;
  key: string;
  project: string;
  projectId: string;
  services: ServiceRow[];
  stacks: StackRow[];
}

export interface ProjectGroup {
  project: string;
  projectId: string;
  scopes: Scope[];
  statusCounts: Record<string, number>;
}

export interface DashboardData {
  groups: ProjectGroup[];
  statusCounts: Record<string, number>;
}

async function buildDashboardData(): Promise<DashboardData> {
  const [serviceRows, stackRows, databaseRows] = await Promise.all([
    loadServiceDashboard(),
    loadStackDashboard(),
    loadDatabaseDashboardRows(),
  ]);

  const scopes = new Map<string, Scope>();
  const ensure = (
    projectId: string,
    project: string,
    environmentId: string,
    environment: string
  ): Scope => {
    const key = scopeKey(project, environment);
    const found = scopes.get(key);
    if (found) {
      return found;
    }
    const created: Scope = {
      databases: [],
      environment,
      environmentId,
      key,
      project,
      projectId,
      services: [],
      stacks: [],
    };
    scopes.set(key, created);
    return created;
  };

  for (const s of serviceRows) {
    ensure(
      s.projectId,
      s.project,
      s.environmentId,
      s.environment
    ).services.push(s);
  }
  for (const s of stackRows) {
    ensure(s.projectId, s.project, s.environmentId, s.environment).stacks.push(
      s
    );
  }
  for (const d of databaseRows) {
    ensure(
      d.projectId,
      d.project,
      d.environmentId,
      d.environment
    ).databases.push(d);
  }

  const sorted = [...scopes.values()].toSorted((a, b) =>
    a.key.localeCompare(b.key)
  );

  const groups: ProjectGroup[] = [];
  for (const scope of sorted) {
    const last = groups.at(-1);
    if (last && last.project === scope.project) {
      last.scopes.push(scope);
    } else {
      groups.push({
        project: scope.project,
        projectId: scope.projectId,
        scopes: [scope],
        statusCounts: {},
      });
    }
  }

  const statusCounts: Record<string, number> = {};
  const tally = (status: string) => {
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;
  };
  const tallyProject = (projectId: string, status: string) => {
    const group = groups.find((g) => g.projectId === projectId);
    if (group) {
      group.statusCounts[status] = (group.statusCounts[status] ?? 0) + 1;
    }
  };
  for (const s of serviceRows) {
    tally(s.status);
    tallyProject(s.projectId, s.status);
  }
  for (const s of stackRows) {
    tally(s.status);
    tallyProject(s.projectId, s.status);
  }
  for (const d of databaseRows) {
    tallyProject(d.projectId, d.status);
    tally(d.status);
  }

  return { groups, statusCounts };
}

export const getDashboardGroups = createServerFn({ method: "GET" }).handler(
  async (): Promise<DashboardData> => {
    await requireSession();
    return buildDashboardData();
  }
);

export const getEnvironmentScope = createServerFn({ method: "GET" })
  .validator(
    z.object({
      environmentId: z.uuid("Choose an environment."),
      projectId: z.uuid("Choose a project."),
    })
  )
  .handler(async ({ data }): Promise<Scope> => {
    await requireSession();

    const environment = await db.query.environments.findFirst({
      where: and(
        eq(environments.id, data.environmentId),
        eq(environments.projectId, data.projectId)
      ),
      with: { project: true },
    });
    if (!environment) {
      throw new Error("environment not found");
    }

    const [serviceRows, stackRows, databaseRows] = await Promise.all([
      loadServiceDashboard(data.environmentId),
      loadStackDashboard(data.environmentId),
      loadDatabaseDashboardRows(data.environmentId),
    ]);

    return {
      databases: databaseRows,
      environment: environment.name,
      environmentId: environment.id,
      key: scopeKey(environment.project.name, environment.name),
      project: environment.project.name,
      projectId: environment.projectId,
      services: serviceRows,
      stacks: stackRows,
    };
  });

export interface DeploymentLogRow {
  commitSha: string | null;
  createdAt: string;
  environment: string;
  environmentId: string;
  finishedAt: string | null;
  id: string;
  kind: "service" | "stack";
  name: string;
  project: string;
  projectId: string;
  resourceId: string;
  serverName: string;
  status: string;
  trigger: string;
}

export const getDeploymentLog = createServerFn({ method: "GET" }).handler(
  async (): Promise<DeploymentLogRow[]> => {
    await requireSession();

    const [serviceRows, stackRows] = await Promise.all([
      db.query.deployments.findMany({
        limit: 200,
        orderBy: desc(deployments.createdAt),
        with: {
          service: {
            with: { environment: { with: { project: true } }, server: true },
          },
        },
      }),
      db.query.stackDeployments.findMany({
        limit: 200,
        orderBy: desc(stackDeployments.createdAt),
        with: {
          stack: {
            with: { environment: { with: { project: true } }, server: true },
          },
        },
      }),
    ]);

    const merged: DeploymentLogRow[] = [
      ...serviceRows.map((d): DeploymentLogRow => ({
        commitSha: d.commitSha,
        createdAt: d.createdAt.toISOString(),
        environment: d.service.environment.name,
        environmentId: d.service.environmentId,
        finishedAt: d.finishedAt?.toISOString() ?? null,
        id: d.id,
        kind: "service",
        name: d.service.name,
        project: d.service.environment.project.name,
        projectId: d.service.environment.projectId,
        resourceId: d.serviceId,
        serverName: d.service.server.name,
        status: d.status,
        trigger: d.trigger,
      })),
      ...stackRows.map((d): DeploymentLogRow => ({
        commitSha: d.commitSha,
        createdAt: d.createdAt.toISOString(),
        environment: d.stack.environment.name,
        environmentId: d.stack.environmentId,
        finishedAt: d.finishedAt?.toISOString() ?? null,
        id: d.id,
        kind: "stack",
        name: d.stack.name,
        project: d.stack.environment.project.name,
        projectId: d.stack.environment.projectId,
        resourceId: d.stackId,
        serverName: d.stack.server.name,
        status: d.status,
        trigger: d.trigger,
      })),
    ];

    merged.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return merged.slice(0, 200);
  }
);

export interface ActivityRow {
  createdAt: string;
  environment: string;
  environmentId: string;
  finishedAt: string | null;
  id: string;
  project: string;
  projectId: string;
  serviceId: string;
  serviceName: string;
  status: string;
  trigger: string;
}

export interface OverviewCounts {
  databases: number;
  deploys7d: number;
  environments: number;
  projects: number;
  services: number;
  stacks: number;
}

export type AttentionKind = "database" | "service" | "stack";

export interface Overview {
  activity: ActivityRow[];
  attention: {
    detail: string | null;
    environmentId: string;
    id: string;
    kind: AttentionKind;
    name: string;
    projectId: string;
    scope: string;
    status: string;
  }[];
  counts: OverviewCounts;
  statusCounts: Record<string, number>;
}

const NEEDS_ATTENTION = new Set(["crashed", "deleting"]);

function collectAttention(
  rows: {
    id: string;
    lastError: string | null;
    name: string;
    status: string;
  }[],
  kind: AttentionKind,
  scope: { environmentId: string; label: string; projectId: string },
  into: Overview["attention"]
): void {
  for (const row of rows) {
    if (NEEDS_ATTENTION.has(row.status)) {
      into.push({
        detail: row.lastError,
        environmentId: scope.environmentId,
        id: row.id,
        kind,
        name: row.name,
        projectId: scope.projectId,
        scope: scope.label,
        status: row.status,
      });
    }
  }
}

export const getOverview = createServerFn({ method: "GET" }).handler(
  async (): Promise<Overview> => {
    await requireSession();
    const { groups, statusCounts } = await buildDashboardData();

    const attention: Overview["attention"] = [];
    for (const group of groups) {
      for (const scope of group.scopes) {
        const context = {
          environmentId: scope.environmentId,
          label: `${group.project} / ${scope.environment}`,
          projectId: group.projectId,
        };
        collectAttention(scope.services, "service", context, attention);
        collectAttention(scope.stacks, "stack", context, attention);
        collectAttention(scope.databases, "database", context, attention);
      }
    }

    const rows = await db.query.deployments.findMany({
      limit: 10,
      orderBy: desc(deployments.createdAt),
      with: {
        service: { with: { environment: { with: { project: true } } } },
      },
    });

    const since = new Date(Date.now() - SEVEN_DAYS_MS);
    const [deployRows, projectRows, environmentRows] = await Promise.all([
      db
        .select({ value: count() })
        .from(deployments)
        .where(gte(deployments.createdAt, since)),
      db.select({ value: count() }).from(projects),
      db.select({ value: count() }).from(environments),
    ]);
    const deploys7d = deployRows[0]?.value ?? 0;
    const projectCount = projectRows[0]?.value ?? 0;
    const environmentCount = environmentRows[0]?.value ?? 0;

    let serviceCount = 0;
    let stackCount = 0;
    let databaseCount = 0;
    for (const group of groups) {
      for (const scope of group.scopes) {
        serviceCount += scope.services.length;
        stackCount += scope.stacks.length;
        databaseCount += scope.databases.length;
      }
    }

    return {
      activity: rows.map((row) => ({
        createdAt: row.createdAt.toISOString(),
        environment: row.service.environment.name,
        environmentId: row.service.environmentId,
        finishedAt: row.finishedAt?.toISOString() ?? null,
        id: row.id,
        project: row.service.environment.project.name,
        projectId: row.service.environment.projectId,
        serviceId: row.serviceId,
        serviceName: row.service.name,
        status: row.status,
        trigger: row.trigger,
      })),
      attention,
      counts: {
        databases: databaseCount,
        deploys7d: deploys7d ?? 0,
        environments: environmentCount,
        projects: projectCount,
        services: serviceCount,
        stacks: stackCount,
      },
      statusCounts,
    };
  }
);
