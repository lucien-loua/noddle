import { useMutation } from "@tanstack/react-query";
import { useCallback, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage } from "@/lib/format";
import { releaseUrl } from "@/lib/source";
import { startUpdate } from "@/server/updates";
import type { UpdateStatus } from "@/server/updates";

function Row({ label, version }: { label: string; version: string | null }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      {version ? (
        <a
          className="underline decoration-dotted underline-offset-2"
          href={releaseUrl(version)}
          rel="noopener"
          target="_blank"
        >
          {version}
        </a>
      ) : (
        <span className="text-muted-foreground">unknown</span>
      )}
    </div>
  );
}

export function UpdateDialog({
  data,
  onOpenChange,
  open,
}: {
  data: UpdateStatus | undefined;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const [started, setStarted] = useState(false);

  const launch = useMutation({
    mutationFn: () => startUpdate(),
    onError: (e: Error) => setFailed(errorMessage(e, "could not start")),
    onSuccess: () => {
      setFailed(null);
      setStarted(true);
    },
  });

  const handleUpdate = useCallback(() => launch.mutate(), [launch]);

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Update Noddle</DialogTitle>
          <DialogDescription>
            The dashboard restarts partway through and comes back on its own.
            Deployed applications keep running.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-3 text-sm">
          <div className="space-y-1.5 rounded-2xl bg-muted p-3">
            <Row label="Running" version={data?.runningVersion ?? null} />
            <Row label="Available" version={data?.remoteVersion ?? null} />
          </div>

          <p className="text-muted-foreground text-xs">
            If the new version misbehaves, Settings offers a roll back to the
            one it replaced. Migrations are not undone either way.
          </p>

          {failed ? (
            <output className="block text-destructive text-xs">{failed}</output>
          ) : null}

          {started ? (
            <p className="flex items-center gap-2 text-xs" role="status">
              <Spinner />
              Updating. This page will stop responding for a moment.
            </p>
          ) : null}
        </DialogBody>

        <DialogFooter>
          <DialogClose render={<Button variant="outline">Close</Button>} />
          <Button
            disabled={launch.isPending || started || !data?.updatable}
            onClick={handleUpdate}
          >
            Update
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
