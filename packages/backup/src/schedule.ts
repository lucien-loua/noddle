import { Cron } from "croner";

/**
 * A config is due when its cron's previous fire is at or after the last
 * successful run of THAT config (or there has never been one).
 *
 * Evaluated every 5 minutes by the worker repeatable job. "Successful", not
 * "attempted": a broken parent must keep retrying.
 */
export function isConfigDue(
  schedule: string,
  lastCompletedAt: Date | null,
  now: Date
): boolean {
  let cron: Cron;
  try {
    cron = new Cron(schedule, { timezone: "UTC" });
  } catch {
    return false;
  }
  const [previous] = cron.previousRuns(1, now);
  if (!previous) {
    return false;
  }
  if (!lastCompletedAt) {
    return true;
  }
  return previous.getTime() > lastCompletedAt.getTime();
}
