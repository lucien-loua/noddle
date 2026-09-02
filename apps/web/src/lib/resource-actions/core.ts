import { deploymentLabel, serviceLabel } from "@/lib/format";
import type { Tone } from "@/lib/format";
import type { ResourceKind, ResourceRow } from "@/lib/scope-rows";

export type Action = "delete" | "deploy" | "restart" | "start" | "stop";

export const PENDING_LABEL: Record<Action, string> = {
  delete: "Deleting",
  deploy: "Deploying",
  restart: "Restarting",
  start: "Starting",
  stop: "Stopping",
};

export const AWAITING_TIMEOUT_MS = 60_000;
export const RESOURCE_POLL_MS = 2000;

export interface Target {
  id: string;
  kind: ResourceKind;
  name: string;
  status: string;
  updatedAt: string;
}

export interface PendingEntry {
  action: Action;
  since: number;
  status: string;
  updatedAt: string;
}

export function key(kind: ResourceKind, id: string): string {
  return `${kind}:${id}`;
}

export function isSettled(
  current: { status: string; updatedAt: string } | undefined,
  entry: PendingEntry,
  now: number = Date.now()
): boolean {
  if (current === undefined || now - entry.since > AWAITING_TIMEOUT_MS) {
    return true;
  }
  if (entry.action === "restart") {
    return current.updatedAt !== entry.updatedAt;
  }
  return current.status !== entry.status;
}

export function refine(
  rows: ReadonlyMap<string, { status: string; updatedAt: string }>,
  pending: ReadonlyMap<string, PendingEntry>,
  now: number = Date.now()
): ReadonlyMap<string, PendingEntry> {
  if (pending.size === 0) {
    return pending;
  }
  let changed = false;
  const next = new Map(pending);
  for (const [k, entry] of pending) {
    if (isSettled(rows.get(k), entry, now)) {
      next.delete(k);
      changed = true;
    }
  }
  return changed ? next : pending;
}

export function withMark(
  pending: ReadonlyMap<string, PendingEntry>,
  k: string,
  entry: PendingEntry
): ReadonlyMap<string, PendingEntry> {
  return new Map(pending).set(k, entry);
}

export function withoutMark(
  pending: ReadonlyMap<string, PendingEntry>,
  k: string
): ReadonlyMap<string, PendingEntry> {
  if (!pending.has(k)) {
    return pending;
  }
  const next = new Map(pending);
  next.delete(k);
  return next;
}

const TRANSIENT_STATUS = new Set(["deleting", "deploying"]);

export function isTransientStatus(status: string): boolean {
  return TRANSIENT_STATUS.has(status);
}

const NOT_YET_ACTIONABLE = new Set(["created", "deleting", "deploying"]);

function isActionable(status: string): boolean {
  return !NOT_YET_ACTIONABLE.has(status);
}

const LIFECYCLE_KINDS = new Set<ResourceKind>(["database", "service"]);
const DEPLOY_KINDS = new Set<ResourceKind>(["service", "stack"]);

export interface ActionPermissions {
  delete: boolean;
  deploy: boolean;
  operate: boolean;
}

export function actionsFor(
  kind: ResourceKind,
  status: string,
  can: ActionPermissions
): Set<Action> {
  const actions = new Set<Action>();
  const permitted = kind === "database" ? can.operate : can.deploy;

  if (LIFECYCLE_KINDS.has(kind) && permitted && isActionable(status)) {
    const stopped = status === "stopped";
    actions.add(stopped ? "start" : "stop");
    if (!stopped) {
      actions.add("restart");
    }
  }
  if (DEPLOY_KINDS.has(kind) && can.deploy && status !== "deleting") {
    actions.add("deploy");
  }
  if (can.delete) {
    actions.add("delete");
  }
  return actions;
}

export function statusOf(
  row: ResourceRow,
  pending: PendingEntry | undefined
): { label: string; tone: Tone } {
  if (pending) {
    return { label: PENDING_LABEL[pending.action], tone: "busy" };
  }
  if (row.inFlightDeployment) {
    return deploymentLabel(row.inFlightDeployment);
  }
  return serviceLabel(row.status);
}

export function pollInterval(
  rows: readonly ResourceRow[],
  pending: ReadonlyMap<string, PendingEntry>,
  intervalMs: number
): false | number {
  if (pending.size > 0) {
    return intervalMs;
  }
  return rows.some((row) => isTransientStatus(row.status)) ? intervalMs : false;
}
