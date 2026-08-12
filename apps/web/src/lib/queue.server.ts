import type { DeployJobData } from "@noddle/deploy-contract";
import { deployJobSchema } from "@noddle/deploy-contract";
import { createDeployQueue } from "@noddle/deploy-contract/queue";
import type { Queue } from "bullmq";
import { redis } from "@/lib/redis.server";

const globalForQueue = globalThis as typeof globalThis & {
  __noddleDeployQueue?: Queue<DeployJobData>;
};

const deployQueue: Queue<DeployJobData> =
  globalForQueue.__noddleDeployQueue ?? createDeployQueue(redis).queue;

globalForQueue.__noddleDeployQueue = deployQueue;

export { deployQueue };

/** Parse with the live contract so deploy-contract HMR isn't masked by a cached closure. */
export function enqueueDeploy(job: DeployJobData): Promise<unknown> {
  const parsed = deployJobSchema.parse(job);
  return deployQueue.add(parsed.kind, parsed);
}
