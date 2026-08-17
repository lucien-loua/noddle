import { DatabaseIcon } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useState } from "react";

import { ConfirmNameDialog } from "@/components/confirm-name-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Frame, FrameFooter, FrameHeader, FramePanel, FrameTitle } from "@/components/ui/frame";
import { errorMessage } from "@/lib/format";
import { rebuildDatabase } from "@/server/databases";

export function DatabaseDangerZone({
  databaseId,
  databaseName,
}: {
  databaseId: string;
  databaseName: string;
}) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rebuild = useMutation({
    mutationFn: (confirmName: string) => rebuildDatabase({ data: { confirmName, databaseId } }),
    onError: (e: Error) => {
      setOpen(false);
      setError(errorMessage(e, "rebuild failed"));
    },
    onSuccess: async () => {
      setOpen(false);
      setError(null);
      await queryClient.invalidateQueries();
      await router.invalidate();
    },
  });

  const handleOpen = useCallback(() => setOpen(true), []);
  const handleConfirm = useCallback((typed: string) => rebuild.mutate(typed), [rebuild]);

  return (
    <Frame>
      <FrameHeader>
        <FrameTitle>Danger zone</FrameTitle>
      </FrameHeader>

      <FramePanel>
        <h3 className="mb-1 font-semibold text-sm">Rebuild database</h3>
        <p className="text-muted-foreground text-sm">
          This action completely resets {databaseName} to its initial state. All data, tables and
          configuration are removed.
        </p>

        {error ? (
          <Alert className="mt-3" variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
      </FramePanel>

      <FrameFooter>
        <Button className="w-full" onClick={handleOpen} variant="destructive">
          <DatabaseIcon data-icon="inline-start" />
          Rebuild database
        </Button>
      </FrameFooter>

      <ConfirmNameDialog
        confirmLabel="Rebuild database"
        description={
          <>
            The running container and its volume are removed, then recreated empty — every table,
            every row, gone. <strong>This cannot be undone.</strong> The database keeps its name,
            engine and credentials; only its contents are wiped.
          </>
        }
        onConfirm={handleConfirm}
        onOpenChange={setOpen}
        open={open}
        pending={rebuild.isPending}
        resourceName={databaseName}
        title={`Rebuild ${databaseName}?`}
      />
    </Frame>
  );
}
