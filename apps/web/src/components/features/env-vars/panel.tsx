import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import {
  type DraftVar,
  EnvVarTable,
} from "@/components/features/env-vars/table";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage } from "@/lib/format";
import { mutations } from "@/lib/mutations";
import { queries } from "@/lib/queries";

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
    ...mutations.saveEnvVars(queryClient, target),
    onError: (e: Error) => setError(errorMessage(e, "could not save")),
  });

  const handleSave = useCallback(
    (draft: DraftVar[]) => {
      setError(null);
      save.mutate(draft);
    },
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
