import type { LogEntry } from "@noddle/shared/logs";

export interface ReplayPlan {
  entries: LogEntry[];
  reset: boolean;
  truncated: boolean;
}

const EVENT_ID = /^\d{1,15}$/;

export const OMITTED_NOTICE = "… earlier output omitted …\n";

export function parseLastEventId(raw: string | null): number | null {
  if (!(raw && EVENT_ID.test(raw))) {
    return null;
  }
  const seq = Number(raw);
  return seq > 0 ? seq : null;
}

export function planReplay(
  buffered: LogEntry[],
  resume: number | null,
  capacity: number
): ReplayPlan {
  const numbered =
    buffered.length > 0 && buffered.every((entry) => entry.seq > 0);
  const oldest = buffered[0]?.seq ?? 0;

  if (resume !== null && numbered && oldest <= resume + 1) {
    return {
      entries: buffered.filter((entry) => entry.seq > resume),
      reset: false,
      truncated: false,
    };
  }

  return {
    entries: buffered,
    reset: true,
    truncated: buffered.length >= capacity,
  };
}
