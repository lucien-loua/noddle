import { Cron } from "croner";

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
