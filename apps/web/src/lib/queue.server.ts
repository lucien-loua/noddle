// Dépôt de travail pour le worker.
//
// Le web ne déploie RIEN lui-même, et ce n'est pas une question de style : il
// tourne sur Bun, où `dockerode` à travers un tunnel SSH ne fonctionne pas.
// La frontière n'est donc pas seulement architecturale, elle est physique.
// Une server function dépose un job, et rend la main tout de suite.
import { Queue } from "bullmq";
import { redis } from "@/lib/redis.server";

/**
 * Pas de « : » dans un nom de file — BullMQ 6 s'en sert comme séparateur de
 * clés Redis et refuse de démarrer. Le nom doit correspondre EXACTEMENT à
 * celui qu'écoute `apps/worker/src/index.ts`.
 */
const DEPLOY_QUEUE = "noddle-deploy";

/**
 * Le même contrat que `DeployJobData` côté worker. Il n'est pas importé :
 * `apps/worker` dépend de `dockerode`, et le web ne doit jamais le charger,
 * même pour un type.
 */
export type DeployJob =
  | { kind: "deploy"; deploymentId: string }
  | { kind: "provision-server"; serverId: string }
  | { kind: "rollback"; imageTag: string; serviceId: string };

const globalForQueue = globalThis as typeof globalThis & {
  __noddleDeployQueue?: Queue<DeployJob>;
};

export const deployQueue: Queue<DeployJob> =
  globalForQueue.__noddleDeployQueue ??
  new Queue<DeployJob>(DEPLOY_QUEUE, { connection: redis });
globalForQueue.__noddleDeployQueue = deployQueue;

export function enqueueDeploy(job: DeployJob): Promise<unknown> {
  return deployQueue.add(job.kind, job);
}
