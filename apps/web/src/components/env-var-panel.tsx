import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { type DraftVar, EnvVarTable } from "@/components/env-var-table";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage } from "@/lib/format";
import { queries } from "@/lib/queries";
import { saveEnvVars } from "@/server/env-vars";

export function EnvVarPanel({
  databaseId,
  effect,
  note,
  serviceId,
}: {
  /** Exactly one of the two — the same rule as in the database. */
  databaseId?: string;
  /** When the save takes effect, said in the right place. */
  effect: string;
  /** What the save will trigger, when it isn't obvious. */
  note?: string;
  serviceId?: string;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const target = serviceId ? { serviceId } : { databaseId };

  const vars = useQuery(queries.envVars(target));

  const save = useMutation({
    mutationFn: (draft: DraftVar[]) =>
      saveEnvVars({
        data: {
          ...target,
          vars: draft.map((v) => ({
            isSecret: v.isSecret,
            key: v.key,
            value: v.value,
          })),
        },
      }),
    onError: (e: Error) => setError(errorMessage(e, "could not save")),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({
        queryKey: queries.envVars(target).queryKey,
      });
    },
  });

  const handleSave = useCallback(
    (draft: DraftVar[]) => save.mutate(draft),
    [save]
  );

  if (!vars.data) {
    return <Spinner />;
  }

  return (
    <>
      {note ? (
        <Alert className="mb-3">
          <AlertDescription>{note}</AlertDescription>
        </Alert>
      ) : null}
      {/* The `key` forces a remount when the saved list changes: the
          table's draft is LOCAL state, initialized only once. Carried over
          as-is from a service's page. */}
      <EnvVarTable
        effect={effect}
        key={vars.data.map((v) => `${v.id}:${v.key}`).join(",")}
        onSave={handleSave}
        pending={save.isPending}
        saved={vars.data}
      />
      {error ? (
        <Alert className="mt-3" variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
    </>
  );
}
