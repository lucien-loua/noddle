export type Tone = "busy" | "danger" | "neutral" | "ok";

const DEPLOYMENT_LABELS: Record<string, { label: string; tone: Tone }> = {
  building: { label: "Building", tone: "busy" },
  deploying: { label: "Deploying", tone: "busy" },
  failed: { label: "Failed", tone: "danger" },
  queued: { label: "Queued", tone: "neutral" },
  reverted_by_watch: { label: "Reverted by watch", tone: "danger" },
  rolled_back: { label: "Rolled back by Swarm", tone: "danger" },
  succeeded: { label: "Deployed", tone: "ok" },
};

const SERVICE_LABELS: Record<string, { label: string; tone: Tone }> = {
  crashed: { label: "Crashed", tone: "danger" },
  created: { label: "Never deployed", tone: "neutral" },
  deleting: { label: "Deleting", tone: "busy" },
  deploying: { label: "Deploying", tone: "busy" },
  running: { label: "Running", tone: "ok" },
  stopped: { label: "Stopped", tone: "neutral" },
};

const BACKUP_LABELS: Record<string, { label: string; tone: Tone }> = {
  completed: { label: "Completed", tone: "ok" },
  failed: { label: "Failed", tone: "danger" },
  queued: { label: "Queued", tone: "neutral" },
  running: { label: "Running", tone: "busy" },
};

const BACKUP_KIND_LABELS: Record<string, string> = {
  manual: "Manual",
  pre_restore: "Before restore",
  scheduled: "Scheduled",
};

export function backupLabel(status: string): { label: string; tone: Tone } {
  return BACKUP_LABELS[status] ?? { label: status, tone: "neutral" };
}

export function backupKindLabel(kind: string): string {
  return BACKUP_KIND_LABELS[kind] ?? kind;
}

const BINARY_UNITS = ["B", "KiB", "MiB", "GiB", "TiB"];
const DECIMAL_UNITS = ["B", "kB", "MB", "GB", "TB"];

export function byteSize(bytes: number, base: 1000 | 1024 = 1024): string {
  if (bytes === 0) {
    return "—";
  }
  const units = base === 1000 ? DECIMAL_UNITS : BINARY_UNITS;
  const exp = Math.min(
    Math.floor(Math.log(bytes) / Math.log(base)),
    units.length - 1
  );
  const value = bytes / base ** exp;
  return `${value.toFixed(exp === 0 ? 0 : 1)} ${units[exp]}`;
}

export function deploymentLabel(status: string): { label: string; tone: Tone } {
  return DEPLOYMENT_LABELS[status] ?? { label: status, tone: "neutral" };
}

export function serviceLabel(status: string): { label: string; tone: Tone } {
  return SERVICE_LABELS[status] ?? { label: status, tone: "neutral" };
}

export function displayNameOf(row: {
  displayName?: string | null;
  name: string;
}): string {
  return row.displayName ?? row.name;
}

export function badgeVariant(
  tone: Tone
): "destructive" | "outline" | "secondary" {
  if (tone === "danger") {
    return "destructive";
  }
  return tone === "neutral" ? "outline" : "secondary";
}

export function dotClass(tone: Tone): string {
  if (tone === "ok") {
    return "bg-success";
  }
  if (tone === "danger") {
    return "bg-destructive";
  }
  if (tone === "busy") {
    return "bg-primary motion-safe:animate-pulse";
  }
  return "bg-muted-foreground/50";
}

const TRIGGER_LABELS: Record<string, string> = {
  manual: "manual",
  rollback: "rollback",
  watch_revert: "watch",
  webhook: "webhook",
};

export function triggerLabel(trigger: string): string {
  return TRIGGER_LABELS[trigger] ?? trigger;
}

const MINUTE = 60;
const HOUR = 3600;
const DAY = 86_400;

export function relativeTime(iso: string): string {
  const seconds = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (seconds < MINUTE) {
    return "just now";
  }
  if (seconds < HOUR) {
    return `${Math.floor(seconds / MINUTE)}m ago`;
  }
  if (seconds < DAY) {
    return `${Math.floor(seconds / HOUR)}h ago`;
  }
  return `${Math.floor(seconds / DAY)}d ago`;
}

const RELATIVE_LONG = new Intl.RelativeTimeFormat("en-US", {
  numeric: "auto",
});

export function relativeTimeLong(iso: string): string {
  const seconds = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (seconds < MINUTE) {
    return "just now";
  }
  if (seconds < HOUR) {
    return RELATIVE_LONG.format(-Math.floor(seconds / MINUTE), "minute");
  }
  if (seconds < DAY) {
    return RELATIVE_LONG.format(-Math.floor(seconds / HOUR), "hour");
  }
  return RELATIVE_LONG.format(-Math.floor(seconds / DAY), "day");
}

export function shortSha(sha: string | null): string {
  return sha ? sha.slice(0, 7) : "—";
}

export function duration(startIso: string, endIso: string | null): string {
  if (!endIso) {
    return "—";
  }
  const seconds = Math.round(
    (Date.parse(endIso) - Date.parse(startIso)) / 1000
  );
  if (seconds < MINUTE) {
    return `${seconds}s`;
  }
  return `${Math.floor(seconds / MINUTE)}m ${seconds % MINUTE}s`;
}

export function errorMessage(err: unknown, fallback: string): string {
  if (!(err instanceof Error)) {
    return fallback;
  }
  const raw = err.message.trim();
  if (!raw.startsWith("[")) {
    return raw || fallback;
  }
  try {
    const issues = JSON.parse(raw) as { message?: string }[];
    const messages = issues
      .map((i) => i.message)
      .filter((m): m is string => Boolean(m));
    return messages.length > 0 ? messages.join(" · ") : fallback;
  } catch {
    return raw;
  }
}
