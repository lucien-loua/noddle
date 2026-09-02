import { Queue } from "bullmq";
import type { ConnectionOptions } from "bullmq";

import { DEPLOY_QUEUE_NAME, deployJobSchema } from "./index.ts";
import type { DeployJobData } from "./index.ts";

export function createDeployQueue(connection: ConnectionOptions): {
  enqueue: (job: DeployJobData) => Promise<unknown>;
  queue: Queue<DeployJobData>;
} {
  const queue = new Queue<DeployJobData>(DEPLOY_QUEUE_NAME, { connection });

  function enqueueDeploy(job: DeployJobData): Promise<unknown> {
    const parsed = deployJobSchema.parse(job);
    return queue.add(parsed.kind, parsed);
  }

  return { enqueue: enqueueDeploy, queue };
}
