import { Queue, Worker } from "bullmq";
import type { ConnectionOptions } from "bullmq";

/**
 * A recurring sweep: one queue, one interval, one body.
 *
 * `deps` is whatever the caller's sweeps need — this package knows nothing
 * about a worker context, and must not: it is imported by `apps/web`, which
 * runs on Bun where `dockerode` over an SSH tunnel does not work (ADR-0015).
 */
export interface ScheduleSpec<TDeps> {
  /** Milliseconds between runs. */
  every: number;
  /**
   * The BullMQ job-scheduler id, which is NOT the queue name.
   *
   * It is stated explicitly because it is an upgrade concern: a scheduler
   * already registered in Redis under its old id survives a deploy, so
   * renaming one leaves the previous entry in place and the sweep fires
   * twice per interval — forever, on every installation that upgrades.
   */
  id: string;
  /** BullMQ queue name. No `:` — BullMQ 6 uses it as a Redis key separator. */
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

/**
 * Starts one sweep and registers its repeat job.
 *
 * **Concurrency is 1 and is not a parameter.** Two overlapping metrics runs
 * would open two SSH sessions per machine and skew the CPU deltas; two watch
 * sweeps would judge the same service twice. Every sweep in this product
 * wants exactly one runner, so the constraint is stated here once instead of
 * being retyped — and forgotten — at each call site.
 */
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
