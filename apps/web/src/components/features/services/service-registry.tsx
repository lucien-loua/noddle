import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { errorMessage } from "@/lib/format";
import type { RoleName } from "@/lib/permissions";
import { queries } from "@/lib/queries";
import { useCan } from "@/lib/use-permission";
import { setServiceRegistry } from "@/server/registries";

/** What `null` means in the selector: a value, not an absence. */
const BUILT_IN = "built-in";

export function ServiceRegistry({
  registryId,
  role,
  serviceId,
}: {
  registryId: string | null;
  role: RoleName | null;
  serviceId: string;
}) {
  const canEdit = useCan(role, "service", "create");
  const queryClient = useQueryClient();

  // Loaded FROM the client and only when configuration is allowed: placed
  // in the route loader, it would fail the whole page for a role that
  // lacks the permission — the `errorComponent` pitfall already paid for
  // on /audit.
  const options = useQuery({
    ...queries.registryOptions(),
    enabled: canEdit,
  });

  const save = useMutation({
    mutationFn: (next: string | null) =>
      setServiceRegistry({ data: { registryId: next, serviceId } }),
    onError: (e: Error) =>
      toast.add({
        description: errorMessage(e, "the registry was not changed"),
        title: "Not saved",
        type: "error",
      }),
    onSuccess: async () => {
      toast.add({
        description: "It takes effect on the next deploy.",
        title: "Registry changed",
        type: "success",
      });
      await queryClient.invalidateQueries();
    },
  });

  const handleChange = useCallback(
    (next: unknown) => {
      if (typeof next !== "string") {
        return;
      }
      save.mutate(next === BUILT_IN ? null : next);
    },
    [save]
  );

  const rows = options.data ?? [];
  const current = rows.find((r) => r.id === registryId);

  // Nothing to choose from as long as no external registry exists: the
  // selector only appears from the first one onward, same rule as the S3
  // destination.
  if (!canEdit || rows.length === 0) {
    return current ? <span>{current.name}</span> : <span>Noddle</span>;
  }

  return (
    <Select
      disabled={save.isPending}
      items={[
        { label: "Noddle", value: BUILT_IN },
        ...rows.map((r) => ({ label: r.name, value: r.id })),
      ]}
      onValueChange={handleChange}
      value={registryId ?? BUILT_IN}
    >
      <SelectTrigger aria-label="Registry" className="h-7 w-full" size="sm">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectItem value={BUILT_IN}>Noddle</SelectItem>
          {rows.map((r) => (
            <SelectItem key={r.id} value={r.id}>
              {r.name}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
