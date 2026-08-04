// Lecture des échantillons de ressources.
//
// La série est rendue TELLE QUELLE, trous compris. Le web ne comble jamais un
// échantillon manquant : c'est au composant de dessiner une interruption, pas
// à la couche données d'inventer une valeur. Un point interpolé serait
// indiscernable d'une mesure, et c'est précisément ce qu'on refuse depuis le
// début de ce chantier.
import { serverMetrics, servers, serviceMetrics } from "@noddle/db/schema";
import { serviceMetricsRequestSchema } from "@noddle/shared/validation";
import { createServerFn } from "@tanstack/react-start";
import { and, asc, eq, gte } from "drizzle-orm";
import { db } from "@/lib/db.server";
import { requireSession } from "@/lib/session.server";

/** La fenêtre affichée. Six heures répondent à « que s'est-il passé cette nuit ». */
const WINDOW_MS = 6 * 60 * 60 * 1000;

export interface MetricPoint {
  cpuLoad1: number;
  diskUsedRatio: number;
  memoryUsedRatio: number;
  sampledAt: string;
}

export interface ServerSeries {
  cpuCount: number;
  /** Le plus récent, ou `null` si rien n'a été collecté sur la fenêtre. */
  latest: MetricPoint | null;
  points: MetricPoint[];
  serverId: string;
  serverName: string;
}

export const getServerMetrics = createServerFn({ method: "GET" }).handler(
  async (): Promise<ServerSeries[]> => {
    await requireSession();
    const since = new Date(Date.now() - WINDOW_MS);

    const machines = await db.query.servers.findMany({
      orderBy: servers.name,
    });

    const out: ServerSeries[] = [];
    for (const machine of machines) {
      // biome-ignore lint/performance/noAwaitInLoops: une machine à la fois, volontairement
      const rows = await db.query.serverMetrics.findMany({
        orderBy: asc(serverMetrics.sampledAt),
        where: and(
          eq(serverMetrics.serverId, machine.id),
          gte(serverMetrics.sampledAt, since)
        ),
      });

      const points: MetricPoint[] = rows.map((r) => ({
        cpuLoad1: r.cpuLoad1,
        // Des ratios plutôt que des octets : c'est ce que l'écran montre, et
        // le convertir ici évite que chaque composant refasse la division
        // — donc qu'un seul d'entre eux se trompe de dénominateur.
        diskUsedRatio:
          r.diskTotalBytes > 0 ? r.diskUsedBytes / r.diskTotalBytes : 0,
        memoryUsedRatio:
          r.memoryTotalBytes > 0 ? r.memoryUsedBytes / r.memoryTotalBytes : 0,
        sampledAt: r.sampledAt.toISOString(),
      }));

      out.push({
        cpuCount: rows.at(-1)?.cpuCount ?? 1,
        latest: points.at(-1) ?? null,
        points,
        serverId: machine.id,
        serverName: machine.name,
      });
    }
    return out;
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// par service
// ─────────────────────────────────────────────────────────────────────────────

export interface ServicePoint {
  cpuPercent: number;
  memoryUsedBytes: number;
  /** `null` quand aucune limite n'est déclarée : le conteneur est borné par
   *  la machine. Distinct de 0, qui voudrait dire « limite nulle ». */
  memoryUsedRatio: number | null;
  sampledAt: string;
  /** Change à chaque redéploiement. Voir `ServiceSeries.restarts`. */
  taskName: string;
}

export interface ServiceSeries {
  latest: ServicePoint | null;
  points: ServicePoint[];
  /**
   * Nombre de tasks distinctes sur la fenêtre.
   *
   * Au-delà de 1, la série couvre plusieurs conteneurs successifs : une chute
   * brutale de mémoire s'y lit comme une fuite corrigée alors que c'est une
   * nouvelle task qui démarre. L'écran le dit plutôt que de laisser conclure.
   */
  restarts: number;
}

export const getServiceMetrics = createServerFn({ method: "GET" })
  .validator(serviceMetricsRequestSchema)
  .handler(async ({ data }): Promise<ServiceSeries> => {
    await requireSession();
    const since = new Date(Date.now() - WINDOW_MS);

    const rows = await db.query.serviceMetrics.findMany({
      orderBy: asc(serviceMetrics.sampledAt),
      where: and(
        eq(serviceMetrics.serviceId, data.serviceId),
        gte(serviceMetrics.sampledAt, since)
      ),
    });

    const points: ServicePoint[] = rows.map((r) => ({
      cpuPercent: r.cpuPercent,
      memoryUsedBytes: r.memoryUsedBytes,
      memoryUsedRatio:
        r.memoryLimitBytes > 0 ? r.memoryUsedBytes / r.memoryLimitBytes : null,
      sampledAt: r.sampledAt.toISOString(),
      taskName: r.taskName,
    }));

    return {
      latest: points.at(-1) ?? null,
      points,
      restarts: new Set(rows.map((r) => r.taskName)).size,
    };
  });
