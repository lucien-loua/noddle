export const RESOURCE_STATUSES = [
  "created",
  "deploying",
  "running",
  "stopped",
  "crashed",
  "deleting",
] as const;

export type ResourceStatus = (typeof RESOURCE_STATUSES)[number];

export const TRANSITIONS: Record<ResourceStatus, readonly ResourceStatus[]> = {
  crashed: ["deploying", "running", "deleting"],
  created: ["deploying", "deleting"],
  deleting: ["deleting"],
  deploying: ["running", "crashed", "deleting"],
  running: ["deploying", "stopped", "crashed", "deleting"],
  stopped: ["deploying", "running", "deleting"],
};

export class IllegalTransitionError extends Error {
  readonly from: ResourceStatus;
  readonly to: ResourceStatus;

  constructor(from: ResourceStatus, to: ResourceStatus) {
    super(`illegal lifecycle transition: ${from} → ${to}`);
    this.name = "IllegalTransitionError";
    this.from = from;
    this.to = to;
  }
}

export function canTransition(
  from: ResourceStatus,
  to: ResourceStatus
): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(
  from: ResourceStatus,
  to: ResourceStatus
): void {
  if (!canTransition(from, to)) {
    throw new IllegalTransitionError(from, to);
  }
}

export interface StatusPatch {
  lastError?: string | null;
  status: ResourceStatus;
}

function patch(
  from: ResourceStatus | null | undefined,
  to: ResourceStatus,
  lastError?: string | null
): StatusPatch {
  if (from) {
    assertTransition(from, to);
  }
  const out: StatusPatch = { status: to };
  if (lastError !== undefined) {
    out.lastError = lastError;
  } else if (to === "running" || to === "stopped") {
    out.lastError = null;
  }
  return out;
}

export function markDeploying(from?: ResourceStatus | null): StatusPatch {
  return patch(from, "deploying", null);
}

export function markRunning(from?: ResourceStatus | null): StatusPatch {
  return patch(from, "running", null);
}

export function markStopped(from?: ResourceStatus | null): StatusPatch {
  return patch(from, "stopped", null);
}

export function markCrashed(
  from: ResourceStatus | null | undefined,
  reason: string
): StatusPatch {
  return patch(from, "crashed", reason);
}

export function markFailed(
  from: ResourceStatus | null | undefined,
  reason: string
): StatusPatch {
  if (from === "deleting") {
    return { lastError: reason, status: "deleting" };
  }
  return markCrashed(from, reason);
}

export function markDeleting(from?: ResourceStatus | null): StatusPatch {
  return patch(from, "deleting", null);
}

export function isStuckDeleting(row: {
  lastError: string | null;
  status: string;
}): boolean {
  return row.status === "deleting" && row.lastError !== null;
}

export function settle(updateState: string): "succeeded" | "rolled_back" {
  if (
    updateState === "rollback_completed" ||
    updateState === "rollback_paused" ||
    updateState === "paused"
  ) {
    return "rolled_back";
  }
  return "succeeded";
}
