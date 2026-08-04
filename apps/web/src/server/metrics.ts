// Lecture des échantillons de ressources.
//
// La série est rendue TELLE QUELLE, trous compris. Le web ne comble jamais un
// échantillon manquant : c'est au composant de dessiner une interruption, pas
// à la couche données d'inventer une valeur. Un point interpolé serait
// indiscernable d'une mesure, et c'est précisément ce qu'on refuse depuis le
// début de ce chantier.
import { serverMetrics, servers } from "@noddle/db/schema";
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
