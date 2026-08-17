import type { QueryKey, UseQueryOptions } from "@tanstack/react-query";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

/**
 * List + invalidate for a settings resource that already has a
 * `queries.*()` entry. Pass the factory (not a spread) so call-site
 * options stay out of the hook.
 *
 * @example
 * const { data, isEmpty, refresh } = useResourceList(queries.sshKeys, initial);
 */
export function useResourceList<TData extends readonly unknown[]>(
  // `queries.*` returns `queryOptions(...)` whose generics don't assign
  // cleanly to a hand-written shape — accept the factory as opaque and
  // read queryKey / queryFn inside.
  createQuery: () => { queryKey: QueryKey; queryFn?: unknown },
  initialData: TData,
  options?: Pick<UseQueryOptions<TData, Error, TData, QueryKey>, "refetchInterval">,
): {
  data: TData;
  isEmpty: boolean;
  refresh: () => Promise<void>;
} {
  const { queryFn, queryKey } = createQuery();
  if (typeof queryFn !== "function") {
    throw new TypeError("useResourceList requires queryFn");
  }

  const queryClient = useQueryClient();
  const result = useQuery({
    initialData,
    queryFn: queryFn as () => Promise<TData>,
    queryKey,
    refetchInterval: options?.refetchInterval,
  });

  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey });
  }, [queryClient, queryKey]);

  const data = (result.data ?? initialData) as TData;
  return {
    data,
    isEmpty: data.length === 0,
    refresh,
  };
}
