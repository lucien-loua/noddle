import { useMutation, useQuery } from "@tanstack/react-query";
import { useCallback, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@/components/ui/frame";
import { Spinner } from "@/components/ui/spinner";
import { byteSize, errorMessage, relativeTime } from "@/lib/format";
import { queries } from "@/lib/queries";
import {
  getControlPlaneSettings,
  runMaintenance,
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
