"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import type { RoleName } from "@/lib/permissions";
import {
  actionsFor as coreActionsFor,
  key,
  pollInterval as corePollInterval,
  refine,
  RESOURCE_POLL_MS,
  statusOf as coreStatusOf,
  withMark,
  withoutMark,
} from "@/lib/resource-actions/core";
import type { Action, PendingEntry, Target } from "@/lib/resource-actions/core";
import { dispatch } from "@/lib/resource-actions/dispatch";
import type { DispatchOptions } from "@/lib/resource-actions/dispatch";
import type { ResourceRow } from "@/lib/scope-rows";
import { useCan } from "@/lib/use-permission";

export { RESOURCE_POLL_MS } from "@/lib/resource-actions/core";
export type { Action, Target } from "@/lib/resource-actions/core";

export type ResourceActions = ReturnType<typeof useResourceActions>;

export function useResourceActions(rows: ResourceRow[], role: RoleName | null) {
  const [pending, setPending] = useState<ReadonlyMap<string, PendingEntry>>(
    () => new Map()
  );

  const canServiceDeploy = useCan(role, "service", "deploy");
  const canServiceDelete = useCan(role, "service", "delete");
  const canDatabaseOperate = useCan(role, "database", "operate");
  const canDatabaseDelete = useCan(role, "database", "delete");

  const rowLookup = useMemo(() => {
    const lookup = new Map<string, { status: string; updatedAt: string }>();
    for (const row of rows) {
      lookup.set(key(row.kind, row.id), {
        status: row.status,
        updatedAt: row.updatedAt,
      });
    }
    return lookup;
  }, [rows]);

  useEffect(() => {
    setPending((prev) => refine(rowLookup, prev));
  }, [rowLookup]);

  const statusOf = useCallback(
    (row: ResourceRow) => coreStatusOf(row, pending.get(key(row.kind, row.id))),
    [pending]
  );

  const actionsFor = useCallback(
    (row: ResourceRow): Set<Action> =>
      coreActionsFor(row.kind, row.status, {
        delete: row.kind === "database" ? canDatabaseDelete : canServiceDelete,
        deploy: canServiceDeploy,
        operate: canDatabaseOperate,
      }),
    [canDatabaseDelete, canDatabaseOperate, canServiceDelete, canServiceDeploy]
  );

  const run = useCallback(
    async (target: Target, action: Action, opts?: DispatchOptions) => {
      const targetKey = key(target.kind, target.id);
      setPending((prev) =>
        withMark(prev, targetKey, {
          action,
          since: Date.now(),
          status: target.status,
          updatedAt: target.updatedAt,
        })
      );
      try {
        return await dispatch(target, action, opts);
      } catch (error) {
        setPending((prev) => withoutMark(prev, targetKey));
        throw error;
      }
    },
    []
  );

  const pollInterval = useMemo(
    () => corePollInterval(rows, pending, RESOURCE_POLL_MS),
    [rows, pending]
  );

  return useMemo(
    () => ({ actionsFor, pollInterval, run, statusOf }),
    [actionsFor, pollInterval, run, statusOf]
  );
}
