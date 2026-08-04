// Collecte des ressources : ce que consomment les machines et les services.
//
// Un passage qui interroge la base, comme `sweepWatch` et `sweepBackups` —
// pas un planificateur par serveur. Même raison : l'état vit dans Postgres,
// donc un Redis vidé ne fait pas disparaître la collecte en silence.
//
// **Un trou dans la série veut dire « on ne regardait pas ».** C'est ce qui
// dicte la forme du code : quand un serveur est injoignable, on n'écrit RIEN
// plutôt qu'une ligne à zéro. Un zéro se lit comme « la machine était calme »,
// ce qui est exactement le contresens à éviter — et l'erreur d'un serveur ne
// doit pas empêcher de collecter les autres.
import {
  serverMetrics,
  servers,
  serviceMetrics,
  services,
} from "@noddle/db/schema";
import {
  type DockerApi,
  disconnect,
  dockerClient,
  exec,
} from "@noddle/ssh-executor";
import { and, eq, lt } from "drizzle-orm";
import { connectTo, type DeployContext } from "#deploy";

/** Sept jours. Au-delà il faudrait agréger, donc une base temporelle. */
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const KIB = 1024;
const WHITESPACE = /\s+/;
const LEADING_SLASH = /^\//;

/**
 * Les faits de la machine, en une commande et sans tuyau fragile.
 *
 * `awk` lit les fichiers directement plutôt que de recevoir un tuyau : ces
 * scripts tournent sous `set -o pipefail`, où un consommateur qui sort tôt
 * fait prendre un SIGPIPE au producteur. `tail -n1` est sûr — il lit jusqu'au
 * bout — contrairement à `head` ou `grep -q`.
 */
const HOST_FACTS = [
  "LOAD=$(awk '{print $1}' /proc/loadavg)",
  "CORES=$(nproc)",
  "MT=$(awk '/^MemTotal:/{print $2}' /proc/meminfo)",
  "MA=$(awk '/^MemAvailable:/{print $2}' /proc/meminfo)",
  "DISK=$(df -B1 --output=size,used / | tail -n1)",
  `printf '%s %s %s %s %s\\n' "$LOAD" "$CORES" "$MT" "$MA" "$DISK"`,
].join("; ");

export interface CollectResult {
  /** Serveurs échantillonnés avec succès. */
  servers: number;
  /** Services échantillonnés avec succès. */
  services: number;
  /** Serveurs injoignables — leur série aura un trou, et c'est voulu. */
  skipped: string[];
}

interface HostSample {
  cpuCount: number;
  cpuLoad1: number;
  diskTotalBytes: number;
  diskUsedBytes: number;
  memoryTotalBytes: number;
  memoryUsedBytes: number;
}

/**
 * Analyse la sortie de `HOST_FACTS`.
 *
 * Renvoie `null` dès qu'un champ manque ou n'est pas un nombre, plutôt que de
 * substituer un zéro : une ligne à moitié vraie est pire qu'une ligne absente,
 * puisqu'elle se trace comme une mesure.
 */
export function parseHostFacts(stdout: string): HostSample | null {
  const parts = stdout.trim().split(WHITESPACE).map(Number);
  if (parts.length !== 6 || parts.some((n) => !Number.isFinite(n))) {
    return null;
  }
  const [load1, cores, memTotalKib, memAvailKib, diskTotal, diskUsed] =
    parts as [number, number, number, number, number, number];
  return {
    cpuCount: cores,
    cpuLoad1: load1,
    diskTotalBytes: diskTotal,
    diskUsedBytes: diskUsed,
    memoryTotalBytes: memTotalKib * KIB,
    // « Utilisée » au sens de ce qui manque pour allouer, pas au sens de
    // `total - free` : le cache pèse dans `free` sans être indisponible, et
    // afficher une machine à 95 % parce qu'elle cache des fichiers ferait
    // paniquer pour rien.
    memoryUsedBytes: (memTotalKib - memAvailKib) * KIB,
  };
}

interface DockerStats {
  cpu_stats?: {
    cpu_usage?: { total_usage?: number };
    online_cpus?: number;
    system_cpu_usage?: number;
  };
  memory_stats?: { limit?: number; usage?: number };
  precpu_stats?: {
    cpu_usage?: { total_usage?: number };
    system_cpu_usage?: number;
  };
}

/**
 * Le pourcentage d'UN cœur, comme le calcule `docker stats`.
 *
 * Mesuré sur une vraie VM : `stats({ stream: false })` renvoie des
 * `precpu_stats` PEUPLÉES — Docker prend deux échantillons en interne — donc
 * un seul appel suffit. Ce n'était pas acquis : sans elles, aucun pourcentage
 * n'aurait été calculable sans doubler les appels.
 *
 * Renvoie `null` si le delta système est nul, ce qui arrive sur un conteneur
 * qui vient de démarrer. Zéro serait faux : on ne sait pas, on ne trace pas.
 */
export function cpuPercent(stats: DockerStats): number | null {
  const cpuDelta =
    (stats.cpu_stats?.cpu_usage?.total_usage ?? 0) -
    (stats.precpu_stats?.cpu_usage?.total_usage ?? 0);
  const systemDelta =
    (stats.cpu_stats?.system_cpu_usage ?? 0) -
    (stats.precpu_stats?.system_cpu_usage ?? 0);
  if (systemDelta <= 0) {
    return null;
  }
  const cores = stats.cpu_stats?.online_cpus ?? 1;
  return (cpuDelta / systemDelta) * cores * 100;
}

/** Le conteneur qui exécute la task de ce service, sur CE nœud. */
async function findContainer(
  docker: DockerApi,
  serviceName: string
): Promise<{ id: string; name: string } | null> {
  const list = await docker.listContainers({
    filters: JSON.stringify({
      label: [`com.docker.swarm.service.name=${serviceName}`],
    }),
  });
  const [first] = list;
  if (!first) {
    return null;
  }
  return {
    id: first.Id,
    name: first.Names?.[0]?.replace(LEADING_SLASH, "") ?? serviceName,
  };
}

async function sampleServer(
  ctx: DeployContext,
  server: typeof servers.$inferSelect,
  result: CollectResult
): Promise<void> {
  const client = await connectTo(ctx, server);
  try {
    const facts = await exec(client, HOST_FACTS);
    const host = facts.code === 0 ? parseHostFacts(facts.stdout) : null;
    if (host) {
      await ctx.db
        .insert(serverMetrics)
        .values({ ...host, serverId: server.id });
      result.servers += 1;
    } else {
      // La commande a répondu mais pas comme prévu : c'est un trou, pas un
      // zéro. On le compte comme un serveur sauté.
      result.skipped.push(server.id);
    }

    const hosted = await ctx.db.query.services.findMany({
      where: and(
        eq(services.serverId, server.id),
        eq(services.status, "running")
      ),
    });
    if (hosted.length === 0) {
      return;
    }

    const docker = dockerClient(client);
    for (const service of hosted) {
      // biome-ignore lint/performance/noAwaitInLoops: un service à la fois, volontairement
      const container = await findContainer(docker, service.name);
      if (!container) {
        continue;
      }
      const stats = (await docker
        .getContainer(container.id)
        .stats({ stream: false })) as DockerStats;

      const percent = cpuPercent(stats);
      const used = stats.memory_stats?.usage;
      if (percent === null || used === undefined) {
        continue;
      }

      await ctx.db.insert(serviceMetrics).values({
        cpuPercent: percent,
        // 0 = pas de limite déclarée. On stocke ce que Docker rend plutôt que
        // de substituer la mémoire de l'hôte, pour que « sans limite » reste
        // lisible comme tel.
        memoryLimitBytes: stats.memory_stats?.limit ?? 0,
        memoryUsedBytes: used,
        serviceId: service.id,
        taskName: container.name,
      });
      result.services += 1;
    }
  } finally {
    disconnect(client);
  }
}

/**
 * Un passage de collecte.
 *
 * L'échec d'un serveur n'empêche pas les autres : chacun est isolé, et un
 * serveur injoignable produit un TROU dans sa série — visible comme tel — au
 * lieu d'une mesure inventée.
 */
export async function collectMetrics(
  ctx: DeployContext
): Promise<CollectResult> {
  const result: CollectResult = { servers: 0, services: 0, skipped: [] };

  const connected = await ctx.db.query.servers.findMany({
    where: eq(servers.status, "connected"),
  });

  for (const server of connected) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: une machine à la fois, volontairement
      await sampleServer(ctx, server, result);
    } catch {
      // Injoignable, SSH refusé, Docker éteint : rien n'est écrit, et c'est
      // le comportement voulu.
      result.skipped.push(server.id);
    }
  }

  await pruneMetrics(ctx);
  return result;
}

/** Efface ce qui dépasse la rétention. Deux tables, une seule règle. */
export async function pruneMetrics(ctx: DeployContext): Promise<void> {
  const cutoff = new Date(Date.now() - RETENTION_MS);
  await ctx.db.delete(serverMetrics).where(lt(serverMetrics.sampledAt, cutoff));
  await ctx.db
    .delete(serviceMetrics)
    .where(lt(serviceMetrics.sampledAt, cutoff));
}
