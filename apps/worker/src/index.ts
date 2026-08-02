// Processus worker.
//
// Séparé du web depuis le premier jour : un déploiement dure des minutes, et
// rien de tout ça ne doit vivre dans le cycle requête/réponse du dashboard.
//
// Tourne sur NODE, pas sur Bun — `dockerode` à travers un tunnel SSH ne
// fonctionne pas sur Bun, mesuré sur les deux approches possibles. Bun reste le
// gestionnaire de paquets et le runtime du web.
import { createDatabase } from "@noddle/db";
import { deployments } from "@noddle/db/schema";
import { loadAppKey } from "@noddle/shared/crypto";
import { Queue, Worker } from "bullmq";
import { eq } from "drizzle-orm";
import IORedis from "ioredis";
import { type DeployContext, type DeployJobData, runJob } from "#deploy";
import { createLogBus } from "#log-bus";
import { sweepWatch } from "#sweep";

// Pas de « : » dans un nom de file : BullMQ 6 le refuse, il s'en sert comme
// séparateur de clés Redis. Le processus ne démarre même pas.
const DEPLOY_QUEUE = "noddle-deploy";
const WATCH_QUEUE = "noddle-watch";

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`variable d'environnement requise : ${name}`);
  }
  return v;
}

const connection = new IORedis(required("REDIS_URL"), {
  // Exigé par BullMQ : sans ça, un job long peut être considéré perdu.
  maxRetriesPerRequest: null,
});

// Le pont vers le dashboard. Le puits de logs écrit sur disque pour
// l'historique ; ceci publie la même source vers le web, qui vit dans un autre
// processus et sur un autre runtime.
const logBus = createLogBus(connection);

const ctx: DeployContext = {
  appKey: loadAppKey(process.env.APP_KEY),
  db: createDatabase({ url: required("DATABASE_URL") }),
  logRoot: process.env.LOG_ROOT ?? "/var/lib/noddle/logs",
  networkName: process.env.TRAEFIK_NETWORK ?? "noddle-public",
  onLog: (deploymentId, chunk) =>
    logBus.publish(deploymentId, { data: chunk, type: "chunk" }),
};

export const deployQueue = new Queue<DeployJobData>(DEPLOY_QUEUE, {
  connection,
});

// ─────────────────────────────────────────────────────────────────────────────
// Déploiements
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Clôt le flux SSE des spectateurs.
 *
 * Le statut est RELU en base plutôt que déduit du fait que le job ait levé ou
 * non : `docker service update` renvoie 0 même après un rollback, et c'est
 * précisément l'erreur que la règle « ne jamais inférer le succès d'un code de
 * sortie » interdit. La base porte l'état réel, lu depuis l'API Docker.
 */
async function announceEnd(deploymentId: string): Promise<void> {
  const row = await ctx.db.query.deployments.findFirst({
    where: eq(deployments.id, deploymentId),
  });
  logBus.publish(deploymentId, {
    status: row?.status ?? "failed",
    type: "end",
  });
}

const deployWorker = new Worker<DeployJobData>(
  DEPLOY_QUEUE,
  async (job) => {
    try {
      await runJob(ctx, job.data);
    } finally {
      // Même en cas d'échec : un onglet ouvert doit voir le flux se fermer,
      // pas rester à attendre indéfiniment.
      if (job.data.kind === "deploy") {
        await announceEnd(job.data.deploymentId);
      }
    }
  },
  {
    // Un seul déploiement à la fois par worker. Deux builds simultanés sur une
    // VM à 2 Go se disputeraient la mémoire que le plafond est censé protéger.
    concurrency: 1,
    connection,
    // Un déploiement dure des minutes : sans ça, BullMQ le croit mort et le
    // relance en parallèle de lui-même.
    lockDuration: 30 * 60 * 1000,
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Surveillance post-déploiement
// ─────────────────────────────────────────────────────────────────────────────
//
// La garantie de Swarm expire avec sa fenêtre monitor : un service qui converge
// puis meurt une minute plus tard est déclaré « completed » et boucle sur
// l'image cassée, sans plus rien à restaurer côté Swarm. Mesuré en Phase 0 :
// 9 requêtes sur 12 en échec, indéfiniment. La logique vit dans sweep.ts pour
// être testable sans démarrer ce processus.

const watchQueue = new Queue(WATCH_QUEUE, { connection });
const watchWorker = new Worker(WATCH_QUEUE, () => sweepWatch(ctx), {
  concurrency: 1,
  connection,
});

await watchQueue.upsertJobScheduler(
  "sweep",
  { every: 30_000 },
  { name: "sweep" }
);

// ─────────────────────────────────────────────────────────────────────────────

for (const w of [deployWorker, watchWorker]) {
  w.on("failed", (job, err) => {
    process.stderr.write(`job ${job?.id} échoué : ${err.message}\n`);
  });
}

async function shutdown(): Promise<void> {
  // Fermeture propre : un déploiement en cours va au bout plutôt que d'être
  // coupé au milieu d'une bascule Swarm.
  await Promise.all([deployWorker.close(), watchWorker.close()]);
  await logBus.close();
  await connection.quit();
}

process.on("SIGTERM", () => {
  shutdown().finally(() => process.exit(0));
});
process.on("SIGINT", () => {
  shutdown().finally(() => process.exit(0));
});

process.stdout.write("worker noddle démarré\n");
