import type { QueryClient } from "@tanstack/react-query";
import type { NavigateOptions } from "@tanstack/react-router";
import { redirect } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useCallback } from "react";

import { TabsContent } from "@/components/ui/tabs";
import { cache } from "@/lib/cache";
import { ActiveTabPanel } from "@/lib/resource-detail/active-tab";
import { DETAIL_TAB_PANEL_CLASS } from "@/lib/resource-detail/constants";
import { getAuthState } from "@/server/auth";

type DetailNavigate = (opts: NavigateOptions) => Promise<void> | void;

export async function resourceDetailBeforeLoad() {
  const state = await getAuthState();
  if (!state.signedIn) {
    throw redirect({ to: "/login" });
  }
  return { email: state.email, role: state.role };
}

export function parseDetailTab<T extends string>(
  value: unknown,
  allowed: readonly T[],
  legacy?: Record<string, T>
): T | undefined {
  if (typeof value !== "string") {
    return;
  }
  if (allowed.includes(value as T)) {
    return value as T;
  }
  return legacy?.[value];
}

export function isDetailTab<T extends string>(
  value: unknown,
  allowed: readonly T[]
): value is T {
  return typeof value === "string" && allowed.includes(value as T);
}

export function useDetailPage<T extends string>({
  defaultTab,
  environmentId,
  navigate,
  preserveTabInSearch = false,
  projectId,
  queryClient,
  resetSearchOnDelete = false,
}: {
  defaultTab: T;
  environmentId: string;
  navigate: DetailNavigate;
  preserveTabInSearch?: boolean;
  projectId: string;
  queryClient: QueryClient;
  resetSearchOnDelete?: boolean;
}) {
  const handleTabChange = useCallback(
    (value: string) => {
      const tab = value === defaultTab ? undefined : (value as T);
      if (preserveTabInSearch) {
        navigate({
          replace: true,
          search: (prev) => ({ ...prev, tab: tab as typeof prev.tab }),
        });
        return;
      }
      navigate({
        replace: true,
        search: { tab } as NavigateOptions["search"],
      });
    },
    [defaultTab, navigate, preserveTabInSearch]
  );

  const handleDeleted = useCallback(async () => {
    await cache.environmentScope(queryClient, projectId, environmentId);
    await navigate({
      params: { environmentId, projectId },
      ...(resetSearchOnDelete ? { search: {} } : {}),
      to: "/projects/$projectId/$environmentId",
    });
  }, [environmentId, navigate, projectId, queryClient, resetSearchOnDelete]);

  return { handleDeleted, handleTabChange };
}

export function DetailTabContent({
  active,
  children,
  className = DETAIL_TAB_PANEL_CLASS,
  lazy = false,
  value,
}: {
  active: string;
  children: ReactNode;
  className?: string;
  lazy?: boolean;
  value: string;
}) {
  return (
    <TabsContent className={className} value={value}>
      {lazy ? (
        <ActiveTabPanel active={active} value={value}>
          {children}
        </ActiveTabPanel>
      ) : (
        children
      )}
    </TabsContent>
  );
}
