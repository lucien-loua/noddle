/** Beyond this, we give up. A slow recipient must not hold up a job. */
const TIMEOUT_MS = 10_000;

const COLOR_FAILURE = 0xd1_3d_3d;
const COLOR_SUCCESS = 0x2e_9e_4f;

export type NotificationKind = "discord" | "slack" | "webhook";

export type NotificationEventType =
  | "backup_failed"
  | "deploy_failed"
  | "deploy_reverted"
  | "deploy_succeeded"
  | "watch_reverted";

export interface NotificationEvent {
  /** Error message or detail. Never a secret: this goes out to a third party. */
  detail?: string;
  /** The name of the service, stack or database involved. */
  resource: string;
  type: NotificationEventType;
  /** Link to the dashboard, when the installation knows its domain. */
  url?: string;
}

export interface NotificationTarget {
  kind: NotificationKind;
  /** In plaintext. Decrypted as close as possible to use, never logged. */
  url: string;
}

export interface DeliveryResult {
  error?: string;
  ok: boolean;
  /** The HTTP status code, when the request succeeded. Absent on a network failure. */
  status?: number;
}

/**
 * The labels, in one place.
 *
 * `deploy_reverted` and `watch_reverted` are deliberately distinguished, as
 * they already are in the database: the first means "Swarm refused the
 * switchover, the old version never stopped serving", the second "the
 * deployment had succeeded, then the application started crash-looping and
 * Noddle stepped in". Conflating them would erase the one difference that
 * matters for the trust placed in the tool.
 */
const LABELS: Record<NotificationEventType, string> = {
  backup_failed: "Backup failed",
  deploy_failed: "Deploy failed",
  deploy_reverted: "Deploy reverted by Swarm",
  deploy_succeeded: "Deployed",
  watch_reverted: "Reverted by watch",
};

export function isFailure(type: NotificationEventType): boolean {
  return type !== "deploy_succeeded";
}

export function eventLabel(type: NotificationEventType): string {
  return LABELS[type];
}

/** A line of text readable as-is, regardless of the recipient. */
function summarize(event: NotificationEvent): string {
  const head = `${LABELS[event.type]} — ${event.resource}`;
  return event.detail ? `${head}\n${event.detail}` : head;
}

/**
 * The payload, per recipient.
 *
 * Discord gets an embed because its color carries the severity: on a
 * channel that scrolls by, it reads without being read. Slack gets plain
 * text — its `blocks` are richer but reject the entire message if a field
 * is malformed, and an alert channel must be robust before being pretty.
 * `webhook` gets Noddle's raw form, the one that wires up to something
 * else: structured, not formatted for display.
 */
export function buildPayload(
  kind: NotificationKind,
  event: NotificationEvent
): unknown {
  const failure = isFailure(event.type);

  if (kind === "discord") {
    return {
      embeds: [
        {
          color: failure ? COLOR_FAILURE : COLOR_SUCCESS,
          description: event.detail ?? undefined,
          fields: event.url
            ? [{ inline: false, name: "Dashboard", value: event.url }]
            : undefined,
          title: `${LABELS[event.type]} — ${event.resource}`,
        },
      ],
      username: "Noddle",
    };
  }

  if (kind === "slack") {
    const suffix = event.url ? `\n<${event.url}|Open dashboard>` : "";
    return {
      text: `${failure ? ":rotating_light:" : ":white_check_mark:"} ${summarize(event)}${suffix}`,
    };
  }

  return {
    at: new Date().toISOString(),
    detail: event.detail ?? null,
    failure,
    resource: event.resource,
    type: event.type,
    url: event.url ?? null,
  };
}

/**
 * Sends, and REPORTS — never throws.
 *
 * The HTTP status is read, not assumed: a revoked Discord webhook responds
 * 404 and a deleted channel 401, without the request failing in the
 * network sense. Concluding from the mere fact that `fetch` succeeded
 * would reproduce exactly the error this project refuses elsewhere —
 * inferring success from an exit code.
 */
export async function deliver(
  target: NotificationTarget,
  event: NotificationEvent
): Promise<DeliveryResult> {
  const body = JSON.stringify(buildPayload(target.kind, event));

  try {
    const response = await fetch(target.url, {
      body,
      headers: { "content-type": "application/json" },
      method: "POST",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (response.ok) {
      return { ok: true, status: response.status };
    }
    // The body is read but TRUNCATED: some gateways return an entire error
    // page, and we don't write ten kilobytes of HTML into a column the UI
    // displays.
    const text = await response.text().catch(() => "");
    return {
      error: `HTTP ${response.status} ${text.slice(0, 300)}`.trim(),
      ok: false,
      status: response.status,
    };
  } catch (error) {
    // The URL does NOT appear in the message: it's a bearer credential —
    // whoever holds it can post to the channel — and this message ends up
    // in a column displayed on screen.
    return { error: describeFailure(error), ok: false };
  }
}

/**
 * A readable cause, WITHOUT the URL and WITHOUT the runtime's message.
 *
 * Two reasons not to pass `err.message` through as-is:
 *
 *   · it's runtime-specific. Node says "fetch failed", Bun says "Unable
 *     to connect. Is the computer able to access the url?". Both send:
 *     the web app (Bun) tests the channels, the worker (Node) fires the
 *     events. The SAME broken channel would therefore display differently
 *     depending on who tried — observed on screen;
 *   · the raw runtime text is noise for the operator reading the channel
 *     row on screen.
 *
 * We only keep the distinction that changes something for the reader:
 * whether the recipient responded too late, or not at all.
 */
function describeFailure(err: unknown): string {
  if (err instanceof Error && err.name === "TimeoutError") {
    return `no response in ${TIMEOUT_MS / 1000}s`;
  }
  return "recipient unreachable";
}
