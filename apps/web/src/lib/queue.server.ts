import {
  DEPLOY_QUEUE_NAME,
  type DeployJobData,
  deployJobSchema,
} from "@noddle/deploy-contract";
import { Queue } from "bullmq";
import { redis } from "@/lib/redis.server";

const globalForQueue = globalThis as typeof globalThis & {
  __noddleDeployQueue?: Queue<DeployJobData>;
};

export const deployQueue: Queue<DeployJobData> =
  globalForQueue.__noddleDeployQueue ??
  new Queue<DeployJobData>(DEPLOY_QUEUE_NAME, { connection: redis });
globalForQueue.__noddleDeployQueue = deployQueue;

export function enqueueDeploy(job: DeployJobData): Promise<unknown> {
  const parsed = deployJobSchema.parse(job);
  return deployQueue.add(parsed.kind, parsed);
}
