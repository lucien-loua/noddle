// La lecture qui alimente l'écran unique.
//
// UNE requête pour tout le dashboard. « chaque service visible d'un coup
// d'œil » n'est pas qu'une consigne d'affichage : si l'écran demandait le
// dernier déploiement service par service, il ferait N+1 requêtes et
// afficherait ses lignes en cascade.
import {
  deployments,
  services,
  stackDeployments,
  stacks,
} from "@noddle/db/schema";
import { createServerFn } from "@tanstack/react-start";
import { desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db.server";
import { requireSession } from "@/lib/session.server";

export interface DeploymentSummary {
  commitSha: string | null;
  createdAt: string;
  finishedAt: string | null;
  id: string;
  imageTag: string | null;
  status: string;
  trigger: string;
}

export interface ServiceRow {
  domain: string | null;
  environment: string;
  gitBranch: string | null;
  gitRepoUrl: string | null;
  id: string;
  lastDeployment: DeploymentSummary | null;
  name: string;
  port: number;
  project: string;
  serverName: string;
  status: string;
  /** Vrai tant que la surveillance post-déploiement observe encore ce service. */
  watching: boolean;
}

export interface StackRow {
  domain: string | null;
  environment: string;
  gitBranch: string;
  gitRepoUrl: string;
  id: string;
  lastDeployment: DeploymentSummary | null;
  name: string;
  port: number | null;
  project: string;
  publicService: string | null;
  serverName: string;
  status: string;
  watching: boolean;
}

function toSummary(row: typeof deployments.$inferSelect): DeploymentSummary {
  return {
    commitSha: row.commitSha,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    id: row.id,
    imageTag: row.imageTag,
    status: row.status,
    trigger: row.trigger,
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
    // Rejouable dès qu'un texte compose est enregistré, que la pile ait
    // construit une image ou seulement pointé vers `image:` — même logique
    // que dans `server/stacks.ts`, dupliquée ici pour la même raison que
    // `toSummary` : une seule ligne, pas une dépendance croisée entre deux
    // modules server-only pour un mapping.
    imageTag: row.composeSource ? row.id : null,
    status: row.status,
    trigger: row.trigger,
  };
}

export const getDashboard = createServerFn({ method: "GET" }).handler(
  async (): Promise<ServiceRow[]> => {
    await requireSession();

    const rows = await db.query.services.findMany({
      orderBy: services.name,
      with: {
        environment: { with: { project: true } },
        server: true,
      },
    });
    if (rows.length === 0) {
      return [];
    }

    // Le dernier déploiement de chaque service en une seule passe. Les
    // déploiements sont triés une fois, puis distribués : le premier vu pour
    // un service est forcément le plus récent.
    const recent = await db.query.deployments.findMany({
      orderBy: desc(deployments.createdAt),
      where: inArray(
        deployments.serviceId,
        rows.map((r) => r.id)
      ),
    });

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

    return rows.map((service) => {
      const last = latest.get(service.id);
      return {
        domain: service.domain,
        environment: service.environment.name,
        gitBranch: service.gitBranch,
        gitRepoUrl: service.gitRepoUrl,
        id: service.id,
        lastDeployment: last ? toSummary(last) : null,
        name: service.name,
        port: service.port,
        project: service.environment.project.name,
        serverName: service.server.name,
        status: service.status,
        watching: watched.has(service.id),
      };
    });
  }
);

export const getStackDashboard = createServerFn({ method: "GET" }).handler(
  async (): Promise<StackRow[]> => {
    await requireSession();

    const rows = await db.query.stacks.findMany({
      orderBy: stacks.name,
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
        gitBranch: stack.gitBranch,
        gitRepoUrl: stack.gitRepoUrl,
        id: stack.id,
        lastDeployment: last ? toStackSummary(last) : null,
        name: stack.name,
        port: stack.port,
        project: stack.environment.project.name,
        publicService: stack.publicService,
        serverName: stack.server.name,
        status: stack.status,
        watching: watched.has(stack.id),
      };
    });
  }
);

export const getDeployments = createServerFn({ method: "GET" })
  .validator((data: { serviceId: string }) => data)
  .handler(async ({ data }): Promise<DeploymentSummary[]> => {
    await requireSession();
    const rows = await db.query.deployments.findMany({
      // L'historique complet est ce qui rend le rollback possible vers
      // n'importe quelle version. Plafonné à l'écran, pas à la requête.
      limit: 50,
      orderBy: desc(deployments.createdAt),
      where: eq(deployments.serviceId, data.serviceId),
    });
    return rows.map(toSummary);
  });
