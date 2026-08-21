"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";

import { toast } from "@/components/ui/toast";
import { cache } from "@/lib/cache";
import { errorMessage } from "@/lib/format";
import { queries } from "@/lib/queries";
import type { Scope } from "@/server/dashboard";
import { deleteDatabase, triggerDatabaseLifecycle } from "@/server/databases";
import { triggerDeploy, triggerLifecycle } from "@/server/deployments";
import { deleteService } from "@/server/services";
import { deleteStack, triggerStackDeploy } from "@/server/stacks";

import { SCOPE_POLL_MS, useAwaitingSettle } from "./scope-poll";
import type { LifecycleKind } from "./topology-node";

/** What `runLifecycle` accepts. `delete` is NOT here on purpose — it goes
 *  through the typed confirmation, never straight from a menu click. */
export type LifecycleName = "deploy" | "restart" | "start" | "stop";

export interface LifecycleTarget {
  id: string;
  /** What to SHOW. */
  label: string;
  /** The IDENTITY, and what a typed delete confirmation is checked against
   *  server-side — `deleteService` compares it to `services.name`. Feeding it
   *  the display name would make a renamed service undeletable. */
  name: string;
  resource: LifecycleKind;
  status: string;
}

/** The same call, routed by type: the resource grid speaks to exactly these
 *  server functions, and a second spelling of "stop" would eventually drift
 *  from the first. */
function runLifecycle(
  target: LifecycleTarget,
  action: LifecycleName
): Promise<unknown> {
  if (action === "deploy") {
    return target.resource === "stack"
      ? triggerStackDeploy({ data: { stackId: target.id } })
      : triggerDeploy({ data: { serviceId: target.id } });
  }
  if (target.resource === "database") {
    return triggerDatabaseLifecycle({
      data: { action, databaseId: target.id },
    });
  }
  return triggerLifecycle({ data: { action, serviceId: target.id } });
}

function removeResource(target: LifecycleTarget, confirmName: string) {
  if (target.resource === "service") {
    return deleteService({ data: { confirmName, serviceId: target.id } });
  }
  if (target.resource === "stack") {
    return deleteStack({ data: { confirmName, stackId: target.id } });
  }
  return deleteDatabase({ data: { confirmName, databaseId: target.id } });
}

/**
 * Running a resource's lifecycle from the canvas, and keeping the canvas
 * honest about it until the server agrees.
 *
 * Split out of `EnvironmentTopology` because it changes for entirely
 * different reasons than what the graph DRAWS — and because the two together
 * put that component past the size where it stops being readable.
 */
export function useTopologyLifecycle(scope: Scope) {
  const queryClient = useQueryClient();
  const [removing, setRemoving] = useState<LifecycleTarget | null>(null);
  const settle = useAwaitingSettle();

  const refreshScope = useCallback(
    () =>
      cache.environmentScope(queryClient, scope.projectId, scope.environmentId),
    [queryClient, scope.environmentId, scope.projectId]
  );

  // The route polls while a status is TRANSIENT. An action fired from here
  // has a window before the status even moves — `stop` leaves a service
  // reading `running` for a second or two — so this second observer on the
  // same key keeps watching until the row actually changes. React Query takes
  // the shortest interval among observers, so the two cannot fight.
  useQuery({
    ...queries.environmentScope(scope.projectId, scope.environmentId),
    refetchInterval: settle.active ? SCOPE_POLL_MS : false,
    staleTime: SCOPE_POLL_MS,
  });

  const rows = useMemo(
    () => [...scope.services, ...scope.stacks, ...scope.databases],
    [scope.databases, scope.services, scope.stacks]
  );

  useEffect(() => settle.refine(rows), [settle, rows]);

  const lifecycle = useMutation({
    mutationFn: ({
      action,
      target,
    }: {
      action: LifecycleName;
      target: LifecycleTarget;
    }) => runLifecycle(target, action),
    onError: (error: Error) =>
      toast.add({
        description: errorMessage(error, "the action was refused"),
        title: "Action failed",
        type: "error",
      }),
    onMutate: ({ action, target }) =>
      settle.mark(target.id, target.status, action),
    onSuccess: () => refreshScope(),
  });

  const remove = useMutation({
    mutationFn: (confirmName: string) => {
      if (!removing) {
        throw new Error("nothing to delete");
      }
      settle.mark(removing.id, removing.status, "delete");
      return removeResource(removing, confirmName);
    },
    onError: (error: Error) => {
      setRemoving(null);
      toast.add({
        description: errorMessage(error, "deletion failed"),
        title: "Not deleted",
        type: "error",
      });
    },
    onSuccess: async () => {
      await refreshScope();
      setRemoving(null);
    },
  });

  return { lifecycle, pending: settle.pending, remove, removing, setRemoving };
}
