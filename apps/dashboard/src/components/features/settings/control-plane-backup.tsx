import { ArchiveIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useCallback, useState } from "react";

import { IconStack } from "@/components/icon-stack";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@/components/ui/frame";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
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

function Outcome({ settings }: { settings: ControlPlaneSettings | undefined }) {
  if (!settings?.backupLastAt) {
    return (
      <FrameDescription>
        No backup has run yet. The first one runs within a day, or start one
        now.
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
  const [failed, setFailed] = useState<string | null>(null);
  const client = useQueryClient();

  const settings = useQuery<ControlPlaneSettings>({
    queryFn: () => getControlPlaneSettings(),
    queryKey: queries.controlPlaneSettings().queryKey,
  });

  const start = useMutation({
    mutationFn: () =>
      runMaintenance({ data: { task: "backup-control-plane" } }),
    onError: (e: Error) => setFailed(errorMessage(e, "could not start")),
    onSuccess: () => setFailed(null),
  });

  const handleStart = useCallback(() => start.mutate(), [start]);

  const destinations = useQuery<DestinationRow[]>({
    queryFn: () => getDestinations(),
    queryKey: queries.destinations().queryKey,
  });

  const choose = useMutation({
    mutationFn: (destinationId: string) =>
      saveBackupDestination({ data: { destinationId } }),
    onError: (e: Error) => setFailed(errorMessage(e, "could not save")),
    onSuccess: async () => {
      setFailed(null);
      await client.invalidateQueries({
        queryKey: queries.controlPlaneSettings().queryKey,
      });
    },
  });

  const noDestinations =
    destinations.isSuccess && (destinations.data?.length ?? 0) === 0;

  const handleChoose = useCallback(
    (value: unknown) => {
      if (typeof value === "string") {
        choose.mutate(value);
      }
    },
    [choose]
  );

  if (noDestinations) {
    return (
      <Frame variant="ghost">
        <FramePanel>
          <Empty className="border-0">
            <EmptyHeader>
              <EmptyMedia>
                <IconStack>
                  <ArchiveIcon className="size-5" />
                </IconStack>
              </EmptyMedia>
              <EmptyTitle>No S3 destination yet</EmptyTitle>
              <EmptyDescription>
                Noddle keeps a dump of its own database somewhere off this
                machine. Add a destination, then choose it here.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button render={<Link to="/destinations" />}>
                <ArchiveIcon data-icon="inline-start" weight="regular" />
                Add a destination
              </Button>
            </EmptyContent>
          </Empty>
        </FramePanel>
      </Frame>
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
            <Select
              onValueChange={handleChoose}
              value={settings.data?.backupDestinationId ?? ""}
            >
              <SelectTrigger
                aria-label="Backup destination"
                className="w-56"
                size="sm"
              >
                <SelectValue placeholder="Choose an S3 destination" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {(destinations.data ?? []).map((row) => (
                    <SelectItem key={row.id} value={row.id}>
                      {row.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
        ) : null}

        <Outcome settings={settings.data} />

        {start.isSuccess ? (
          <FrameDescription role="status">
            Queued. Reload in a moment to see the result.
          </FrameDescription>
        ) : null}

        {failed ? (
          <output className="block text-destructive text-xs">{failed}</output>
        ) : null}
      </FramePanel>
    </Frame>
  );
}
