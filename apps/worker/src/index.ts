// Processus worker.
//
// Séparé du web depuis le premier jour : un déploiement dure des minutes, et
// rien de tout ça ne doit vivre dans le cycle requête/réponse du dashboard.
//
// Tourne sur NODE, pas sur Bun — `dockerode` à travers un tunnel SSH ne
// fonctionne pas sur Bun, mesuré sur les deux approches possibles. Bun reste le
// gestionnaire de paquets et le runtime du web.
import { createDatabase } from "@noddle/db";
import { deployments, stackDeployments } from "@noddle/db/schema";
import { loadAppKey } from "@noddle/shared/crypto";
import { Queue, Worker } from "bullmq";
import { eq } from "drizzle-orm";
import IORedis from "ioredis";
import { sweepBackups } from "#backup-sweep";
import {
  connectTo,
  type DeployContext,
  type DeployJobData,
  runJob,
} from "#deploy";
import { createLogBus } from "#log-bus";
import { collectMetrics } from "#metrics";
import { loadRegistryConfig, sweepRegistryTrust } from "#registry";
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
  // Posé par l'installateur UNIQUEMENT quand un domaine est configuré : sans
  // nom, aucun certificat n'est possible et les applications sortent en HTTP.
  certResolver: process.env.CERT_RESOLVER || undefined,
  db: createDatabase({ url: required("DATABASE_URL") }),
  logRoot: process.env.LOG_ROOT ?? "/var/lib/noddle/logs",
  networkName: process.env.TRAEFIK_NETWORK ?? "noddle-public",
  onLog: (deploymentId, chunk) =>
    logBus.publish(deploymentId, { data: chunk, type: "chunk" }),
  // Absent sur une installation dont la pile n'a pas encore le registre : le
  // worker retombe alors exactement sur le comportement d'avant, build local
  // et service épinglé. C'est ce qui rend une mise à jour sans danger.
  registry: loadRegistryConfig(),
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

/** Même rôle qu'`announceEnd`, pour un déploiement de pile. */
async function announceStackEnd(stackDeploymentId: string): Promise<void> {
  const row = await ctx.db.query.stackDeployments.findFirst({
    where: eq(stackDeployments.id, stackDeploymentId),
  });
  logBus.publish(stackDeploymentId, {
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
      // pas rester à attendre indéfiniment. Un provisionnement de serveur n'a
      // pas de déploiement associé : rien à clore côté SSE.
      if (job.data.kind === "deploy") {
        await announceEnd(job.data.deploymentId);
      } else if (job.data.kind === "deploy-stack") {
        await announceStackEnd(job.data.stackDeploymentId);
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
// Sauvegardes planifiées
// ─────────────────────────────────────────────────────────────────────────────
//
// Un passage qui interroge Postgres, pas un planificateur BullMQ par base :
// l'état vit dans la base, donc un Redis vidé — ce qui arrive, c'est un cache —
// ne fait pas disparaître les planifications en silence. Cinq minutes suffisent
// pour un rythme quotidien ou hebdomadaire.

const BACKUP_SWEEP_QUEUE = "noddle-backup-sweep";

const backupSweepQueue = new Queue(BACKUP_SWEEP_QUEUE, { connection });
const backupSweepWorker = new Worker(
  BACKUP_SWEEP_QUEUE,
  () =>
    sweepBackups(ctx, (backupId) =>
      deployQueue.add("backup", { backupId, kind: "backup" })
    ),
  { concurrency: 1, connection }
);

await backupSweepQueue.upsertJobScheduler(
  "backup-sweep",
  { every: 300_000 },
  { name: "backup-sweep" }
);

// ─────────────────────────────────────────────────────────────────────────────
// Confiance au registre
// ─────────────────────────────────────────────────────────────────────────────
//
// Chaque nœud doit porter l'AC du registre, sinon son démon refuse de tirer.
// Les serveurs ajoutés passent par `provisionServer`, qui la dépose ; ce
// passage-ci existe pour les DEUX cas que le provisionnement ne couvre pas :
// les serveurs déjà en place avant que le registre existe, et ceux qui étaient
// injoignables au moment où on a essayé.
//
// Cinq minutes : ça n'écrit un fichier de 2 Ko qu'une fois, et ne fait plus
// rien ensuite.

const TRUST_QUEUE = "noddle-registry-trust";

const trustQueue = new Queue(TRUST_QUEUE, { connection });
const trustWorker = new Worker(
  TRUST_QUEUE,
  () =>
    sweepRegistryTrust({
      connectTo: (server) => connectTo(ctx, server),
      db: ctx.db,
      registry: ctx.registry,
    }),
  { concurrency: 1, connection }
);

await trustQueue.upsertJobScheduler(
  "registry-trust",
  { every: 300_000 },
  { name: "registry-trust" }
);

// ─────────────────────────────────────────────────────────────────────────────
// Rétention du registre
// ─────────────────────────────────────────────────────────────────────────────
//
// Le passage n'exécute RIEN lui-même : il dépose un job sur la file des
// déploiements. C'est le point qui compte — `garbage-collect` supprime les
// couches qu'aucun manifeste ne référence, et une couche en cours d'envoi est
// exactement dans ce cas. Seule la concurrence 1 de cette file-là garantit
// qu'un GC ne tourne jamais pendant un push. Même raison que les sauvegardes,
// qui partagent la file pour ne pas se disputer la mémoire d'une machine à
// 2 Go.
//
// Une heure : le registre grossit d'un déploiement à la fois, il n'y a rien à
// rattraper plus vite que ça.

const PRUNE_QUEUE = "noddle-registry-prune";

const pruneQueue = new Queue(PRUNE_QUEUE, { connection });
const pruneWorker = new Worker(
  PRUNE_QUEUE,
  () => deployQueue.add("prune-registry", { kind: "prune-registry" }),
  { concurrency: 1, connection }
);

await pruneQueue.upsertJobScheduler(
  "registry-prune",
  { every: 3_600_000 },
  { name: "registry-prune" }
);

// ─────────────────────────────────────────────────────────────────────────────
// Collecte des ressources
// ─────────────────────────────────────────────────────────────────────────────
//
// Une minute : assez fin pour voir une fuite mémoire monter, assez large pour
// qu'une machine à 2 Go ne passe pas son temps à se mesurer elle-même.

const METRICS_QUEUE = "noddle-metrics";

const metricsQueue = new Queue(METRICS_QUEUE, { connection });
const metricsWorker = new Worker(METRICS_QUEUE, () => collectMetrics(ctx), {
  // Concurrence 1 : deux passages qui se chevauchent ouvriraient deux
  // connexions SSH par machine et fausseraient les deltas CPU.
  concurrency: 1,
  connection,
});

await metricsQueue.upsertJobScheduler(
  "collect",
  { every: 60_000 },
  { name: "collect" }
);

// ─────────────────────────────────────────────────────────────────────────────

for (const w of [
  deployWorker,
  watchWorker,
  backupSweepWorker,
  metricsWorker,
  trustWorker,
  pruneWorker,
]) {
  w.on("failed", (job, err) => {
    process.stderr.write(`job ${job?.id} échoué : ${err.message}\n`);
  });
}

async function shutdown(): Promise<void> {
  // Fermeture propre : un déploiement en cours va au bout plutôt que d'être
  // coupé au milieu d'une bascule Swarm.
  await Promise.all([
    deployWorker.close(),
    watchWorker.close(),
    backupSweepWorker.close(),
    metricsWorker.close(),
    trustWorker.close(),
    pruneWorker.close(),
  ]);
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
