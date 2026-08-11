import { type ConnectionOptions, Queue } from "bullmq";
import {
  DEPLOY_QUEUE_NAME,
  type DeployJobData,
  deployJobSchema,
} from "./index.ts";

/**
 * Shared deploy-queue factory for web and worker.
 *
 * Parse once, then `add(parsed.kind, parsed)`. Never a raw `.add` on this
 * queue. Lives on a subpath so the package root stays free of bullmq.
 */
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
