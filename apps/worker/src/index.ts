// Processus worker.
//
// Séparé du web depuis le premier jour : un déploiement dure des minutes, et
// rien de tout ça ne doit vivre dans le cycle requête/réponse du dashboard.
//
// Tourne sur NODE, pas sur Bun — `dockerode` à travers un tunnel SSH ne
// fonctionne pas sur Bun, mesuré sur les deux approches possibles. Bun reste le
// gestionnaire de paquets et le runtime du web.
import { createDatabase } from "@noddle/db";
import { deployments, services } from "@noddle/db/schema";
import {
  decryptSecret,
  loadAppKey,
  secretContext,
} from "@noddle/shared/crypto";
import { connect, disconnect, dockerClient } from "@noddle/ssh-executor";
import { Queue, Worker } from "bullmq";
import { and, desc, eq, gt, isNotNull, lt, ne } from "drizzle-orm";
import IORedis from "ioredis";
import {
  type DeployContext,
  type DeployJobData,
  redeployImage,
  runDeploy,
} from "./deploy.ts";
import { inspectServiceHealth } from "./watch.ts";

const DEPLOY_QUEUE = "noddle:deploy";
const WATCH_QUEUE = "noddle:watch";

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

const ctx: DeployContext = {
  appKey: loadAppKey(process.env.APP_KEY),
  db: createDatabase({ url: required("DATABASE_URL") }),
  logRoot: process.env.LOG_ROOT ?? "/var/lib/noddle/logs",
  networkName: process.env.TRAEFIK_NETWORK ?? "noddle-public",
};

export const deployQueue = new Queue<DeployJobData>(DEPLOY_QUEUE, {
  connection,
});

// ─────────────────────────────────────────────────────────────────────────────
// Déploiements
// ─────────────────────────────────────────────────────────────────────────────

const deployWorker = new Worker<DeployJobData>(
  DEPLOY_QUEUE,
  (job) => runDeploy(ctx, job.data),
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

/**
 * Passe en revue les déploiements encore sous surveillance.
 *
 * Existe parce que la garantie de Swarm expire avec sa fenêtre monitor : un
 * service qui converge puis meurt une minute plus tard est déclaré « completed »
 * et boucle sur l'image cassée, sans plus rien à restaurer côté Swarm. Mesuré
 * en Phase 0 : 9 requêtes sur 12 en échec, indéfiniment.
 */
async function sweepWatch(): Promise<void> {
  const now = new Date();
  const pending = await ctx.db.query.deployments.findMany({
    where: and(
      eq(deployments.status, "succeeded"),
      isNotNull(deployments.watchUntil),
      gt(deployments.watchUntil, now)
    ),
    with: { service: { with: { server: true } } },
  });

  await Promise.all(
    pending.map(async (dep) => {
      const { service } = dep;
      const privateKey = decryptSecret(
        service.server.sshPrivateKeyEncrypted,
        ctx.appKey,
        secretContext.serverSshKey(service.server.id)
      );
      const client = await connect({
        host: service.server.host,
        port: service.server.sshPort,
        privateKey,
        user: service.server.sshUser,
      });

      try {
        const verdict = await inspectServiceHealth(
          dockerClient(client),
          service.name,
          dep.finishedAt ?? dep.createdAt
        );
        if (!verdict.crashLooping) {
          return;
        }

        // Le déploiement précédent qui a réellement servi. Noddle peut viser
        // n'importe quelle version de son historique — Swarm n'en garde qu'une.
        const previous = await ctx.db.query.deployments.findFirst({
          orderBy: desc(deployments.createdAt),
          where: and(
            eq(deployments.serviceId, service.id),
            eq(deployments.status, "succeeded"),
            ne(deployments.id, dep.id),
            isNotNull(deployments.imageTag),
            lt(deployments.createdAt, dep.createdAt)
          ),
        });

        await ctx.db
          .update(deployments)
          .set({
            errorMessage: `boucle de crash détectée après le déploiement (${verdict.failures} échecs) : ${verdict.lastError ?? "sans détail"}`,
            status: "reverted_by_watch",
            watchUntil: null,
          })
          .where(eq(deployments.id, dep.id));

        if (!previous?.imageTag) {
          // Rien vers quoi revenir : première version du service. On ne peut que
          // le signaler — masquer l'état serait pire.
          await ctx.db
            .update(services)
            .set({ status: "crashed" })
            .where(eq(services.id, service.id));
          return;
        }

        await redeployImage(ctx, {
          imageTag: previous.imageTag,
          serviceId: service.id,
          trigger: "watch_revert",
        });
      } finally {
        disconnect(client);
      }
    })
  );
}

const watchQueue = new Queue(WATCH_QUEUE, { connection });
const watchWorker = new Worker(WATCH_QUEUE, () => sweepWatch(), {
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
  await connection.quit();
}

process.on("SIGTERM", () => {
  shutdown().finally(() => process.exit(0));
});
process.on("SIGINT", () => {
  shutdown().finally(() => process.exit(0));
});

process.stdout.write("worker noddle démarré\n");
