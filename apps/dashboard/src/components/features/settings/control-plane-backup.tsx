import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";

import { NoDestinationEmpty } from "@/components/features/backups/no-destination-empty";
import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@/components/ui/frame";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { byteSize, errorMessage, relativeTime } from "@/lib/format";
import { queries } from "@/lib/queries";
import { getDestinations } from "@/server/backups/destinations";
import type { DestinationRow } from "@/server/backups/destinations";
import {
  getControlPlaneSettings,
  runMaintenance,
  saveBackupDestination,
} from "@/server/control-plane";
import type { ControlPlaneSettings } from "@/server/control-plane";

const POLL_MS = 5000;

function Outcome({ settings }: { settings: ControlPlaneSettings | undefined }) {
  if (!settings?.backupLastAt) {
    return (
      <FrameDescription>
        No backup has run yet. The next one runs within a day.
      </FrameDescription>
    );
  }

  if (settings.backupLastError) {
    return (
      <output className="block text-destructive text-xs">
        {relativeTime(settings.backupLastAt)}: {settings.backupLastError}
      </output>
    );
  }

  return (
    <dl className="space-y-1.5 text-xs">
      <div className="flex items-center gap-3">
        <dt className="min-w-0 flex-1 text-muted-foreground">Last backup</dt>
        <dd>{relativeTime(settings.backupLastAt)}</dd>
      </div>
      {settings.backupLastBytes ? (
        <div className="flex items-center gap-3">
          <dt className="min-w-0 flex-1 text-muted-foreground">Size</dt>
          <dd>{byteSize(settings.backupLastBytes)}</dd>
        </div>
      ) : null}
      {settings.backupLastKey ? (
        <div className="flex items-center gap-3">
          <dt className="min-w-0 flex-1 text-muted-foreground">Object</dt>
          <dd className="truncate font-mono">{settings.backupLastKey}</dd>
        </div>
      ) : null}
    </dl>
  );
}

export function ControlPlaneBackup({ canRun }: { canRun: boolean }) {
  const client = useQueryClient();
  const [awaiting, setAwaiting] = useState<string | null | undefined>();

  const settings = useQuery<ControlPlaneSettings>({
    queryFn: () => getControlPlaneSettings(),
    queryKey: queries.controlPlaneSettings().queryKey,
    refetchInterval: (query) =>
      awaiting !== undefined && query.state.data?.backupLastAt === awaiting
        ? POLL_MS
        : false,
  });

  const destinations = useQuery<DestinationRow[]>({
    queryFn: () => getDestinations(),
    queryKey: queries.destinations().queryKey,
  });

  const start = useMutation({
    mutationFn: () =>
      runMaintenance({ data: { task: "backup-control-plane" } }),
    onError: (error: Error) =>
      toast.add({
        description: errorMessage(error, "backup failed"),
        title: "Could not queue the backup",
        type: "error",
      }),
    onSuccess: () => {
      setAwaiting(settings.data?.backupLastAt ?? null);
      toast.add({ title: "Backup queued", type: "success" });
    },
  });

  const choose = useMutation({
    mutationFn: (destinationId: string) =>
      saveBackupDestination({ data: { destinationId } }),
    onError: (error: Error) =>
      toast.add({
        description: errorMessage(error, "could not save"),
        title: "Could not change the destination",
        type: "error",
      }),
    onSuccess: () =>
      client.invalidateQueries({
        queryKey: queries.controlPlaneSettings().queryKey,
      }),
  });

  const handleStart = useCallback(() => start.mutate(), [start]);

  const handleChoose = useCallback(
    (row: DestinationRow | null) => {
      if (row) {
        choose.mutate(row.id);
      }
    },
    [choose]
  );

  const rows = destinations.data ?? [];
  const selected =
    rows.find((row) => row.id === settings.data?.backupDestinationId) ?? null;

  if (destinations.isSuccess && rows.length === 0) {
    return (
      <NoDestinationEmpty
        description="Noddle needs somewhere to push its own database dump before the daily backup can run. Add one under"
        heading="Backing up Noddle itself"
        intro="A dump of the control plane database, kept somewhere that is not this machine."
      />
    );
  }

  return (
    <Frame variant="ghost">
      <FrameHeader className="flex-row items-center justify-between gap-3">
        <div>
          <FrameTitle>Backing up Noddle itself</FrameTitle>
          <FrameDescription>
            A dump of the control plane database. Restoring it also needs
            APP_KEY from installer/.env — without the key it cannot be read.
          </FrameDescription>
        </div>
        {canRun ? (
          <Button
            disabled={start.isPending}
            onClick={handleStart}
            size="xs"
            variant="outline"
          >
            {start.isPending ? <Spinner /> : null}
            Back up now
          </Button>
        ) : null}
      </FrameHeader>

      <FramePanel className="space-y-3">
        {canRun ? (
          <div className="flex items-center gap-3 text-xs">
            <span className="min-w-0 flex-1 text-muted-foreground">
              Destination
            </span>
            <Combobox
              items={rows}
              itemToStringLabel={(row: DestinationRow) => row.name}
              itemToStringValue={(row: DestinationRow) => row.name}
              onValueChange={handleChoose}
              value={selected}
            >
              <ComboboxInput
                aria-label="Backup destination"
                placeholder="Choose an S3 destination"
              />
              <ComboboxContent>
                <ComboboxEmpty>No destination matches.</ComboboxEmpty>
                <ComboboxList>
                  {(row: DestinationRow) => (
                    <ComboboxItem key={row.id} value={row}>
                      {row.name}
                    </ComboboxItem>
                  )}
                </ComboboxList>
              </ComboboxContent>
            </Combobox>
          </div>
        ) : null}

        <Outcome settings={settings.data} />
      </FramePanel>
    </Frame>
  );
}
