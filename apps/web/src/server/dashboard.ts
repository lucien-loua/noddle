import {
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

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

import z from "zod";
import { db } from "@/lib/db.server";
import { requireSession } from "@/lib/session.server";
import {
  type DatabaseRow,
  loadDatabaseDashboardRows,
} from "@/server/databases/read";

export interface DeploymentSummary {
  commitSha: string | null;
  createdAt: string;
  finishedAt: string | null;
  id: string;
  /**
   * The image was removed from the registry by retention. The history row
   * itself stays — but "Redeploy" would become a certain failure, and a
   * screen that offers an action it knows is impossible lies exactly like a
   * false status badge.
   */
  imagePurged: boolean;
  imageTag: string | null;
  /**
   * The SWARM NODE where the task actually runs, when known. With a
   * registry the image is portable: the service's server only says where
   * it gets BUILT anymore.
   */
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
  buildMethod: "nixpacks" | "dockerfile" | "image";
  dockerImage: string | null;
  domains: ServiceDomainRow[];
  environment: string;
  environmentId: string;
  gitBranch: string | null;
  gitRepoUrl: string | null;
  id: string;
  lastDeployment: DeploymentSummary | null;
  /** Why a teardown failed. `null` if nothing failed, or once the service is
   *  gone for good — the row disappears with it. */
  lastError: string | null;
  name: string;
  port: number;
  /**
   * The pull request number, when this service is a preview.
   *
   * They are NOT hidden from the dashboard: a preview runs, can be broken,
   * and hiding it would be exactly the lie this screen exists to avoid.
   * They live in the `preview` environment, so grouping by (project,
   * environment) already sets them apart — all that was missing was saying
   * which PR it is.
   */
  prNumber: number | null;
  project: string;
  projectId: string;
  /** Static build output, relative to the repo root. `null` = server process. */
  publishDirectory: string | null;
  /** `null` = the built-in registry. */
  registryId: string | null;
  serverHost: string;
  serverName: string;
  sourceType: "git" | "github" | "gitlab" | "docker_image" | "compose";
  status: string;
  /** ISO timestamp — Restart stays `running`, so the project grid settles
   *  its pending "Restarting" badge off this bump instead. */
  updatedAt: string;
  /** True as long as post-deploy monitoring is still watching this service. */
  watching: boolean;
}

export interface StackRow {
  domain: string | null;
  environment: string;
  environmentId: string;
  gitBranch: string;
  gitRepoUrl: string;
  id: string;
  lastDeployment: DeploymentSummary | null;
  /** Why a teardown failed. `null` once the stack is gone for good — the
   *  row disappears with it. */
  lastError: string | null;
  name: string;
  port: number | null;
  project: string;
  projectId: string;
  publicService: string | null;
  serverName: string;
  status: string;
  watching: boolean;
}

/**
 * Translates a Swarm node id into a readable server name.
 *
 * A single query for the whole dashboard: the `servers` table has a handful
 * of rows, and re-reading it per deployment would be absurd.
 */
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
    // `null` when the node is unknown OR when it's no longer registered —
    // never the raw id as a fallback: a screen showing "wyt3n0w9sb92"
    // informs nobody.
    nodeName: row.nodeId ? (nodes.get(row.nodeId) ?? null) : null,
    status: row.status,
    trigger: row.trigger,
  };
}

interface ServiceJoined {
  buildMethod: "nixpacks" | "dockerfile" | "image";
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
  gitRepoUrl: string | null;
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
}

function toServiceRow(
  service: ServiceJoined,
  last: typeof deployments.$inferSelect | undefined,
  nodes: Map<string, string>,
  watching: boolean
): ServiceRow {
  return {
    buildMethod: service.buildMethod,
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
    gitRepoUrl: service.gitRepoUrl,
    id: service.id,
    lastDeployment: last ? toSummary(last, nodes) : null,
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
    // Registry retention doesn't touch stacks: their replay starts from the
    // saved compose TEXT, not from a kept image.
    imagePurged: false,
    // Replayable as soon as a compose text is saved, whether the stack
    // built an image or only pointed to `image:` — same logic as in
    // `server/stacks.ts`, duplicated here for the same reason as
    // `toSummary`: a single line, not a cross-dependency between two
    // server-only modules for one mapping.
    imageTag: row.composeSource ? row.id : null,
    // A stack stays pinned to its server — a compose file can declare
    // volumes, and letting Swarm move it would lose the data. The question
    // "where does it run" therefore always has the same answer as
    // `serverName`, and asking it here would teach nothing new.
    nodeName: null,
    status: row.status,
    trigger: row.trigger,
  };
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

  // The last deployment of each service in a single pass. Deployments are
  // sorted once, then distributed: the first one seen for a service is
  // necessarily the most recent.
  const recent = await db.query.deployments.findMany({
    orderBy: desc(deployments.createdAt),
    where: inArray(
      deployments.serviceId,
      rows.map((r) => r.id)
    ),
  });

  const nodes = await nodeNames();
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

  return rows.map((service) =>
    toServiceRow(
      service,
      latest.get(service.id),
      nodes,
      watched.has(service.id)
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

    const last = await db.query.deployments.findFirst({
      orderBy: desc(deployments.createdAt),
      where: eq(deployments.serviceId, row.id),
    });
    const nodes = await nodeNames();
    const watching = Boolean(
      last?.watchUntil && last.watchUntil.getTime() > Date.now()
    );
    return toServiceRow(row, last ?? undefined, nodes, watching);
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
    const rows = await db.query.deployments.findMany({
      // The full history is what makes rollback possible to any version.
      // Capped on the screen, not on the query.
      limit: 50,
      orderBy: desc(deployments.createdAt),
      where: eq(deployments.serviceId, data.serviceId),
    });
    const nodes = await nodeNames();
    return rows.map((row) => toSummary(row, nodes));
  });

/** What a project and an environment have in common, and so what a row no
 *  longer has to repeat. */
function scopeKey(project: string, environment: string): string {
  return `${project}/${environment}`;
}

export interface Scope {
  databases: DatabaseRow[];
  environment: string;
  environmentId: string;
  key: string;
  project: string;
  /** Necessary since a resource's URL carries its project: a scope that
   *  only knows the project's NAME can't build that link. */
  projectId: string;
  services: ServiceRow[];
  stacks: StackRow[];
}

export interface ProjectGroup {
  project: string;
  projectId: string;
  scopes: Scope[];
  /**
   * The same rollup as `DashboardData.statusCounts`, but scoped to THIS
   * project — which makes a `/projects` card readable without opening the
   * project. Computed HERE, not in the component: "grouped by project" is a
   * fact about the data, the same rule that already moved the grouping out
   * of a client `useMemo` on 2026-08-06.
   */
  statusCounts: Record<string, number>;
}

export interface DashboardData {
  groups: ProjectGroup[];
  /**
   * How many resources are in each status, across ALL types — a crashed
   * service and a crashed database are both "something is wrong", and
   * separating them would force mental addition.
   *
   * The raw STATUSES, not labels: translating is the display layer's job
   * (`serviceLabel`), which already does it for every row. The server
   * counts, it doesn't write copy.
   */
  statusCounts: Record<string, number>;
}

/**
 * The dashboard's grouping — BY PROJECT FIRST, then environment — computed
 * HERE, not in the client component. "Grouped by project" is a fact about
 * the data, not a display preference: it has to hold true for any client of
 * this read, not just the one that wrote today's `useMemo`.
 */
async function buildDashboardData(): Promise<DashboardData> {
  const [serviceRows, stackRows, databaseRows] = await Promise.all([
    loadServiceDashboard(),
    loadStackDashboard(),
    loadDatabaseDashboardRows(),
  ]);

  const scopes = new Map<string, Scope>();
  const scopeProjectId = new Map<string, string>();
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
    scopeProjectId.set(key, projectId);
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

  const sorted = [...scopes.values()].sort((a, b) =>
    a.key.localeCompare(b.key)
  );

  const groups: ProjectGroup[] = [];
  for (const scope of sorted) {
    const last = groups.at(-1);
    if (last && last.project === scope.project) {
      last.scopes.push(scope);
    } else {
      // biome-ignore lint/style/noNonNullAssertion: `scopeProjectId` is populated by `ensure` before any scope, in lockstep with `scopes`
      const projectId = scopeProjectId.get(scope.key)!;
      groups.push({
        project: scope.project,
        projectId,
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

/**
 * One environment's inventory — Services, Stacks, Databases — for the grid.
 *
 * Distinct from `getDashboardGroups`: that ships every project. Here we load
 * only the rows that belong to `environmentId`, and still return an empty
 * Scope (with project/environment names) when nothing is deployed yet.
 */
export const getEnvironmentScope = createServerFn({ method: "GET" })
  .validator(z.object({ environmentId: z.uuid(), projectId: z.uuid() }))
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

/**
 * A row of the deployment log — services AND stacks, flattened.
 *
 * `kind` carries the origin because the two live in DIFFERENT tables
 * (`deployments`, `stack_deployments`): without it, the screen wouldn't
 * know which detail page to send you to, and two ids from distinct tables
 * could collide.
 */
export interface DeploymentLogRow {
  commitSha: string | null;
  createdAt: string;
  environment: string;
  /** The project and environment as IDs, not just names: a resource's URL
   *  now carries both of them. */
  environmentId: string;
  finishedAt: string | null;
  id: string;
  kind: "service" | "stack";
  name: string;
  project: string;
  projectId: string;
  /** The RESOURCE's id, not the deployment's: it's this one that opens the
   *  detail page. */
  resourceId: string;
  serverName: string;
  status: string;
  trigger: string;
}

/**
 * The full history, for /deployments.
 *
 * Capped at 200: this screen answers "what happened recently", not
 * "everything since the installation". A service's detail page keeps its
 * own history, capped at 50 per resource there.
 *
 * The two tables are read separately, then merged and re-sorted in memory —
 * a SQL UNION would require both to have the same columns, which isn't the
 * case (`node_id`, `image_purged` on one side, `compose_source` on the
 * other) and would force inventing null columns on both sides for a screen
 * that shows seven of them.
 */
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
      ...serviceRows.map(
        (d): DeploymentLogRow => ({
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
        })
      ),
      ...stackRows.map(
        (d): DeploymentLogRow => ({
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
        })
      ),
    ];

    // Re-sorted AFTER merging: each table is already sorted on its own, but
    // the two interleaved are not.
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
  /** Over SEVEN days, not "since forever": a cumulative total never moves
   *  enough to be worth looking at twice. */
  deploys7d: number;
  environments: number;
  projects: number;
  services: number;
  stacks: number;
}

export interface Overview {
  activity: ActivityRow[];
  /** What ISN'T running, across all types — the only list worth reading
   *  first. Empty = everything is fine, and the screen says so. */
  attention: {
    detail: string | null;
    href: string;
    id: string;
    name: string;
    scope: string;
    status: string;
  }[];
  counts: OverviewCounts;
  statusCounts: Record<string, number>;
}

/** An in-progress deployment is NOT an anomaly: it will finish. Only states
 *  where something got stuck matter. */
const NEEDS_ATTENTION = new Set(["crashed", "deleting"]);

/** The three types only differ by their URL prefix: a single pass rather
 *  than three near-identical blocks. */
function collectAttention(
  rows: {
    id: string;
    lastError: string | null;
    name: string;
    status: string;
  }[],
  prefix: string,
  scope: string,
  into: Overview["attention"]
): void {
  for (const row of rows) {
    if (NEEDS_ATTENTION.has(row.status)) {
      into.push({
        detail: row.lastError,
        href: `${prefix}/${row.id}`,
        id: row.id,
        name: row.name,
        scope,
        status: row.status,
      });
    }
  }
}

/**
 * The home screen: what's wrong, then what just happened.
 *
 * Distinct from `getDashboardGroups`, which renders the full inventory.
 * Here we only answer "do I need to deal with something?" — the only
 * question you ask when opening Noddle.
 */
export const getOverview = createServerFn({ method: "GET" }).handler(
  async (): Promise<Overview> => {
    await requireSession();
    // One session check, one inventory load — do not re-enter getDashboardGroups
    // as a server function (that would re-auth and re-read servers).
    const { groups, statusCounts } = await buildDashboardData();

    const attention: Overview["attention"] = [];
    for (const group of groups) {
      for (const scope of group.scopes) {
        const label = `${group.project} / ${scope.environment}`;
        collectAttention(scope.services, "/services", label, attention);
        collectAttention(scope.stacks, "/stacks", label, attention);
        collectAttention(scope.databases, "/databases", label, attention);
      }
    }

    // SERVICE deployments only: stack ones live in a different table, and
    // mixing them would require sorting two sets in memory for a screen
    // that only shows the last ten. Worth revisiting the day someone
    // notices.
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
