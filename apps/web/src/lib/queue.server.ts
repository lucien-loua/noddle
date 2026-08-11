import type { DeployJobData } from "@noddle/deploy-contract";
import { createDeployQueue } from "@noddle/deploy-contract/queue";
import type { Queue } from "bullmq";
import { redis } from "@/lib/redis.server";

const globalForQueue = globalThis as typeof globalThis & {
  __noddleDeployQueue?: ReturnType<typeof createDeployQueue>;
};

const created = globalForQueue.__noddleDeployQueue ?? createDeployQueue(redis);
globalForQueue.__noddleDeployQueue = created;

export const deployQueue: Queue<DeployJobData> = created.queue;
export const enqueueDeploy = created.enqueue;
