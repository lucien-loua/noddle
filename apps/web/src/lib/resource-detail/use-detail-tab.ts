import type { NavigateOptions } from "@tanstack/react-router";
import { useCallback } from "react";

type DetailTabNavigate = (opts: NavigateOptions) => Promise<void> | void;

export function useDetailTabChange<T extends string>(
  navigate: DetailTabNavigate,
  defaultTab: T,
  opts?: { preserveSearch?: boolean }
) {
  return useCallback(
    (value: string) => {
      const tab = value === defaultTab ? undefined : (value as T);
      if (opts?.preserveSearch) {
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
    [defaultTab, navigate, opts?.preserveSearch]
  );
}
