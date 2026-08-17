import type { DockerApi } from "@noddle/ssh-executor";

export interface WatchVerdict {
  /** True if the service is crash looping: it converged then started restarting. */
  crashLooping: boolean;
  /** Number of failed tasks since monitoring started. */
  failures: number;
  lastError: string | null;
}

/**
 * Trigger threshold.
 *
 * Two failures, not one: a task can die once for a reason unrelated to the
 * deployment (a one-off OOM, a daemon restart). Rolling back over an isolated
 * incident would be worse than letting it pass — it would cancel a healthy
 * deployment.
 */
export const CRASH_LOOP_THRESHOLD = 2;

export async function inspectServiceHealth(
  docker: DockerApi,
  serviceName: string,
  since: Date,
): Promise<WatchVerdict> {
  const tasks = await docker.listTasks({
    filters: JSON.stringify({ service: [serviceName] }),
  });

  const sinceMs = since.getTime();
  let failures = 0;
  let lastError: string | null = null;

  for (const t of tasks as unknown as {
    Status?: { State?: string; Timestamp?: string; Err?: string };
  }[]) {
    const state = t.Status?.State;
    const ts = t.Status?.Timestamp ? Date.parse(t.Status.Timestamp) : 0;

    // `failed` and `rejected` only. `shutdown` is the NORMAL state of a task
    // drained during a successful update: counting it would make every
    // deployment look like a crash loop.
    if ((state === "failed" || state === "rejected") && ts >= sinceMs) {
      failures += 1;
      lastError = t.Status?.Err ?? lastError;
    }
  }

  return {
    crashLooping: failures >= CRASH_LOOP_THRESHOLD,
    failures,
    lastError,
  };
}

/** Duration for which a deployment remains under monitoring. */
export const WATCH_WINDOW_MS = 5 * 60 * 1000;

/**
 * Instant at which Post-deploy watch expires. The worker's
 * `recordAcceptedService` / `recordAcceptedStack` are the only callers —
 * arming lives in one module so Rollback and watch recovery cannot skip it.
 */
export function watchUntilFor(startedAt: Date): Date {
  return new Date(startedAt.getTime() + WATCH_WINDOW_MS);
}
