"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";

import { toast } from "@/components/ui/toast";
import { cache } from "@/lib/cache";
import { errorMessage } from "@/lib/format";
import type { RoleName } from "@/lib/permissions";
import { queries } from "@/lib/queries";
import {
  RESOURCE_POLL_MS,
  useResourceActions,
} from "@/lib/resource-actions/use-resource-actions";
import { scopeRows } from "@/lib/scope-rows";
import type { ResourceRow } from "@/lib/scope-rows";
import type { Scope } from "@/server/dashboard";

export type LifecycleName = "deploy" | "restart" | "start" | "stop";

export function useTopologyLifecycle(scope: Scope, role: RoleName | null) {
  const queryClient = useQueryClient();
  const [removing, setRemoving] = useState<ResourceRow | null>(null);

  const rows = useMemo(() => scopeRows(scope), [scope]);
  const actions = useResourceActions(rows, role);

  const refreshScope = useCallback(
    () =>
      cache.environmentScope(queryClient, scope.projectId, scope.environmentId),
    [queryClient, scope.environmentId, scope.projectId]
  );

  useQuery({
    ...queries.environmentScope(scope.projectId, scope.environmentId),
    refetchInterval: actions.pollInterval,
    staleTime: RESOURCE_POLL_MS,
  });

  const lifecycle = useMutation({
    mutationFn: ({
      action,
      target,
    }: {
      action: LifecycleName;
      target: ResourceRow;
    }) => actions.run(target, action),
    onError: (error: Error) =>
      toast.add({
        description: errorMessage(error, "the action was refused"),
        title: "Action failed",
        type: "error",
      }),
    onSuccess: () => refreshScope(),
  });

  const remove = useMutation({
    mutationFn: (confirmName: string) => {
      if (!removing) {
        throw new Error("nothing to delete");
      }
      return actions.run(removing, "delete", { confirmName });
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

  return { actions, lifecycle, remove, removing, rows, setRemoving };
}
