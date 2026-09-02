import { Queue, Worker } from "bullmq";
import type { ConnectionOptions } from "bullmq";

export interface ScheduleSpec<TDeps> {
  every: number;
  id: string;
  queue: string;
  run: (deps: TDeps) => Promise<unknown>;
}

export function defineSchedule<TDeps>(
  spec: ScheduleSpec<TDeps>
): ScheduleSpec<TDeps> {
  return spec;
}

export interface RunningSchedule {
  close: () => Promise<void>;
  queue: string;
}

export async function startSchedule<TDeps>(
  spec: ScheduleSpec<TDeps>,
  opts: {
    connection: ConnectionOptions;
    deps: TDeps;
    onFailed: (queue: string, message: string) => void;
  }
): Promise<RunningSchedule> {
  const queue = new Queue(spec.queue, { connection: opts.connection });
  const worker = new Worker(spec.queue, () => spec.run(opts.deps), {
    concurrency: 1,
    connection: opts.connection,
  });

  worker.on("failed", (job, err) => {
    opts.onFailed(spec.queue, `job ${job?.id} failed: ${err.message}`);
  });

  await queue.upsertJobScheduler(
    spec.id,
    { every: spec.every },
    { name: spec.id }
  );

  return { close: () => worker.close(), queue: spec.queue };
}
