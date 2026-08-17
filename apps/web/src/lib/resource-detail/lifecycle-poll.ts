import type { LifecycleAction } from "@/components/use-lifecycle-actions";

import { AWAITING_TIMEOUT_MS, DETAIL_POLL_MS } from "./constants";

export interface AwaitingLifecycle {
  action: LifecycleAction;
  since: number;
  status: string;
  updatedAt: string;
}

export interface LifecyclePollRow {
  status: string;
  updatedAt: string;
}

export function isLifecycleSettled(
  row: LifecyclePollRow,
  awaiting: AwaitingLifecycle
): boolean {
  if (Date.now() - awaiting.since > AWAITING_TIMEOUT_MS) {
    return true;
  }
  if (awaiting.action === "restart") {
    return row.updatedAt !== awaiting.updatedAt;
  }
  return row.status !== awaiting.status;
}

export function lifecyclePollInterval(
  row: LifecyclePollRow | undefined,
  awaiting: AwaitingLifecycle | null,
  opts?: { forcePoll?: boolean }
): number | false {
  if (!row) {
    return false;
  }
  if (opts?.forcePoll) {
    return DETAIL_POLL_MS;
  }
  if (!awaiting) {
    return false;
  }
  return isLifecycleSettled(row, awaiting) ? false : DETAIL_POLL_MS;
}
