/** shadcn's `Badge` variants, plus the healthy state specific to Noddle. */
export type Tone = "busy" | "danger" | "neutral" | "ok";

/**
 * The statuses the database distinguishes, made readable.
 *
 * `rolled_back` and `reverted_by_watch` are deliberately kept separate,
 * because the difference is exactly what matters for the trust one places
 * in the tool: the first means "Swarm refused the switch-over, the old
 * version never stopped serving", the second "the deployment had
 * succeeded, then the application started crash-looping and Noddle
 * stepped in".
 */
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
  // Teardown is IN PROGRESS, hence `busy` and not `neutral`: a row that
  // stays here is a teardown that failed, not a stable state. The status
  // has existed since Phase 4 but never had a label — so it showed up as
  // raw "deleting", the only lowercase word amid capitalized badges.
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

/**
 * Where a backup comes from.
 *
 * "Before restore" deserves its own label: it's the safety net taken
 * automatically right before the product's only irreversible operation,
 * and finding it in the list without knowing where it came from would be
 * confusing at the exact moment one is trying to feel reassured.
 */
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

/**
 * Object size, in units the eye reads without counting digits.
 *
 * **The base is explicit because the label must tell the truth.** This
 * function used to divide by 1024 and write "GB", a classic display-side
 * mix-up: 1024³ bytes make a GiB, not a GB.
 *
 * The mistake is only visible when a REFERENCE FIGURE exists alongside it.
 * Disk usage breakdown has one — `docker system df`, which formats in
 * DECIMAL (measured) — so a screen announcing "3.3 GB" where the machine
 * says "3.575GB" would read as a disagreement about the bytes, when it's
 * only a disagreement about the unit. Hence `base: 1000` there and only
 * there.
 */
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

/**
 * What a human calls it, falling back to the identity.
 *
 * Applied at the BOUNDARY where a row becomes something the screen draws, not
 * at each `<span>`: `name` stays the identity everywhere it matters — the
 * Swarm service, the volumes, the unique index — and display code keeps
 * reading one field.
 */
export function displayNameOf(row: {
  displayName?: string | null;
  name: string;
}): string {
  return row.displayName ?? row.name;
}

/** A status's tone, translated into a `Badge` variant. */
export function badgeVariant(
  tone: Tone
): "destructive" | "outline" | "secondary" {
  if (tone === "danger") {
    return "destructive";
  }
  return tone === "neutral" ? "outline" : "secondary";
}

/** The status dot: it's what answers "is it running?" without reading anything. */
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

/** Spelled out — "2 days ago", not "2d ago". For a sentence, where the
 *  compact form above belongs in a table cell. `numeric: "auto"` is what
 *  turns -1 day into "yesterday"; the locale is explicit because the two
 *  runtimes that render this page do not share a default. */
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

/** A deployment's duration, once it's finished. */
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

/**
 * The readable message for a server function error.
 *
 * When a Zod validator rejects an input, TanStack Start propagates the
 * SERIALIZED issues array as the error message. Displayed as-is, the form
 * shows JSON to the user — observed in a real browser on "Discord and
 * Slack only accept https:// URLs", which came out surrounded by
 * brackets, quotes, and a `code` field.
 *
 * We can't fix this server-side without giving up shared validation:
 * that's just the shape of the transport. So we undo it at display time,
 * the only place where someone actually reads it.
 */
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
    // A message that starts with `[` without being JSON: we return it as-is
    // rather than swallowing a potentially useful cause.
    return raw;
  }
}
