import type { DockerApi } from "@noddle/ssh-executor";

export interface WatchVerdict {
  crashLooping: boolean;
  failures: number;
  lastError: string | null;
}

export const CRASH_LOOP_THRESHOLD = 2;

export async function inspectServiceHealth(
  docker: DockerApi,
  serviceName: string,
  since: Date
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

export const WATCH_WINDOW_MS = 5 * 60 * 1000;

export function watchUntilFor(startedAt: Date): Date {
  return new Date(startedAt.getTime() + WATCH_WINDOW_MS);
}
