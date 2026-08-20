import { useCallback, useMemo, useState } from "react";

import type { Scope } from "@/server/dashboard";

export const SCOPE_POLL_MS = 2000;

/** Statuses that are in-flight: a view polls until they leave. */
const TRANSIENT_STATUS = new Set(["deleting", "deploying"]);

export function isTransientStatus(status: string): boolean {
  return TRANSIENT_STATUS.has(status);
}

export function scopeIsTransient(scope: Scope): boolean {
  return (
    scope.services.some((s) => isTransientStatus(s.status)) ||
    scope.stacks.some((s) => isTransientStatus(s.status)) ||
    scope.databases.some((d) => isTransientStatus(d.status))
  );
}

/**
 * Ids whose status we are waiting to MOVE after firing an action.
 *
 * `scopeIsTransient` alone is not enough: `stop` leaves a service `running`
 * for a second or two before Swarm drains it, so a view that polled only on
 * transient statuses would stop watching exactly when the change was about to
 * arrive. An entry is dropped as soon as the status it was dispatched against
 * differs, and unconditionally after `AWAITING_TIMEOUT_MS` so a job that never
 * lands cannot poll forever.
 *
 * The resource grid keeps its own copy of this rule with bulk selection woven
 * through it; this is the same rule for a view that only ever acts on one
 * resource at a time.
 */
const AWAITING_TIMEOUT_MS = 60_000;

export type PendingAction = "delete" | "deploy" | "restart" | "start" | "stop";

/** What a resource reads as while we wait. The server has not moved yet — a
 *  `stop` leaves a service saying `running` for a second or two — so this is
 *  the ONLY thing standing between the click and the change. */
export const PENDING_LABEL: Record<PendingAction, string> = {
  delete: "Deleting",
  deploy: "Deploying",
  restart: "Restarting",
  start: "Starting",
  stop: "Stopping",
};

interface Awaiting {
  action: PendingAction;
  since: number;
  status: string;
}

export interface AwaitingSettle {
  /** Whether anything is still expected to move. */
  active: boolean;
  /** Id to the label it should read as, until the real status catches up. */
  pending: ReadonlyMap<string, string>;
  /** Record that `id` was acted on while it read `status`. */
  mark: (id: string, status: string, action: PendingAction) => void;
  /** Drop whatever has since moved, or timed out. Give it the current rows. */
  refine: (rows: { id: string; status: string }[]) => void;
}

export function useAwaitingSettle(): AwaitingSettle {
  const [awaiting, setAwaiting] = useState<ReadonlyMap<string, Awaiting>>(
    () => new Map()
  );

  const mark = useCallback(
    (id: string, status: string, action: PendingAction) => {
      setAwaiting(
        (prev) =>
          new Map([...prev, [id, { action, since: Date.now(), status }]])
      );
    },
    []
  );

  const refine = useCallback((rows: { id: string; status: string }[]) => {
    setAwaiting((prev) => {
      if (prev.size === 0) {
        return prev;
      }
      const now = Date.now();
      const next = new Map(prev);
      for (const [id, entry] of prev) {
        const row = rows.find((r) => r.id === id);
        const settled =
          !row ||
          row.status !== entry.status ||
          now - entry.since > AWAITING_TIMEOUT_MS;
        if (settled) {
          next.delete(id);
        }
      }
      return next.size === prev.size ? prev : next;
    });
  }, []);

  const pending = useMemo(
    () =>
      new Map(
        [...awaiting].map(([id, entry]) => [id, PENDING_LABEL[entry.action]])
      ),
    [awaiting]
  );

  // Memoised as one object: the consumer feeds `refine` from an effect, and a
  // fresh identity every render would re-run it on every render.
  return useMemo(
    () => ({ active: awaiting.size > 0, mark, pending, refine }),
    [awaiting.size, mark, pending, refine]
  );
}
