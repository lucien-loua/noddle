import type { QueryClient } from "@tanstack/react-query";
import type { NavigateOptions } from "@tanstack/react-router";
import { useCallback } from "react";
import { cache } from "@/lib/cache";

interface LeaveOnDeleteOpts {
  environmentId: string;
  navigate: (opts: NavigateOptions) => Promise<void> | void;
  projectId: string;
  queryClient: QueryClient;
  /** Clear URL search params when returning to the environment list. */
  resetSearch?: boolean;
}

export function useLeaveOnDelete({
  environmentId,
  navigate,
  projectId,
  queryClient,
  resetSearch = false,
}: LeaveOnDeleteOpts) {
  return useCallback(async () => {
    await cache.environmentScope(queryClient, projectId, environmentId);
    await navigate({
      params: { environmentId, projectId },
      ...(resetSearch ? { search: {} } : {}),
      to: "/projects/$projectId/$environmentId",
    });
  }, [environmentId, navigate, projectId, queryClient, resetSearch]);
}
