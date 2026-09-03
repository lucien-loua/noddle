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
  detail?: string;
  resource: string;
  type: NotificationEventType;
  url?: string;
}

export interface NotificationTarget {
  kind: NotificationKind;
  url: string;
}

export interface DeliveryResult {
  error?: string;
  ok: boolean;
  status?: number;
}

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

function summarize(event: NotificationEvent): string {
  const head = `${LABELS[event.type]} — ${event.resource}`;
  return event.detail ? `${head}\n${event.detail}` : head;
}

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
    const text = await response.text().catch(() => "");
    return {
      error: `HTTP ${response.status} ${text.slice(0, 300)}`.trim(),
      ok: false,
      status: response.status,
    };
  } catch (error) {
    return { error: describeFailure(error), ok: false };
  }
}

function describeFailure(err: unknown): string {
  if (err instanceof Error && err.name === "TimeoutError") {
    return `no response in ${TIMEOUT_MS / 1000}s`;
  }
  return "recipient unreachable";
}
