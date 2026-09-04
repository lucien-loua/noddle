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
import { errorMessage } from "@/lib/format";
import type { RoleName } from "@/lib/permissions";
import { queries } from "@/lib/queries";
import { useCan } from "@/lib/use-permission";
import { getUpdateStatus, startUpdate } from "@/server/updates";
import type { UpdateStatus } from "@/server/updates";

const POLL_MS = 5000;

const SHORT = 12;

// oxlint-disable-next-line no-control-regex -- this is precisely the ESC character we're targeting
const ANSI = /\u001B\[[0-9;]*m/g;

function Commit({
  sha,
  version,
}: {
  sha: string | null;
  version?: string | null;
}) {
  if (!(sha || version)) {
    return <span className="text-muted-foreground">unknown</span>;
  }
  return (
    <span className="flex items-baseline gap-2">
      {version ? <span>{version}</span> : null}
      {sha ? (
        <span className="font-mono text-muted-foreground text-xs">
          {sha.slice(0, SHORT)}
        </span>
      ) : null}
    </span>
  );
}

function UpdateNotes({
  data,
  done,
  failed,
  inFlight,
  running,
}: {
  data: UpdateStatus | undefined;
  done: boolean;
  failed: string | null;
  inFlight: boolean;
  running: string | null;
}) {
  return (
    <>
      {data?.unreachable ? (
        <FrameDescription>
          Could not reach the host that holds this installation:{" "}
          {data.unreachable}
        </FrameDescription>
      ) : null}

      {running === null && !data?.unreachable ? (
        <FrameDescription>
          {data?.remoteCommit
            ? "This installation predates version stamping, so Noddle cannot tell how far behind it is. Updating is safe either way: the installer is idempotent."
            : "This process was not built by the installer, so it carries no version. Updating from here is only meaningful on an installed machine."}
        </FrameDescription>
      ) : null}

      {failed ? (
        <output className="block text-destructive text-xs">{failed}</output>
      ) : null}

      {inFlight ? (
        <FrameDescription role="status">
          Updating. The dashboard restarts partway through, so this page will
          stop responding for a moment. It comes back on its own.
        </FrameDescription>
      ) : null}

      {done ? (
        <FrameDescription role="status">
          Updated. Reload the page to pick up the new dashboard assets.
        </FrameDescription>
      ) : null}
    </>
  );
}

export function UpdatePanel({ role }: { role: RoleName | null }) {
  const canUpdate = useCan(role, "installation", "update");
  const [started, setStarted] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const status = useQuery<UpdateStatus>({
    queryFn: () => getUpdateStatus(),
    queryKey: queries.updateStatus().queryKey,
    refetchInterval: started ? POLL_MS : false,
    retry: true,
  });

  const launch = useMutation({
    mutationFn: () => startUpdate(),
    onError: (e: Error) => setFailed(errorMessage(e, "could not start")),
    onSuccess: () => {
      setFailed(null);
      setStarted(status.data?.runningCommit ?? "unknown");
    },
  });

  const handleClick = useCallback(() => launch.mutate(), [launch]);

  const { data } = status;
  const running = data?.runningCommit ?? null;
  const done = Boolean(started && running && running !== started);
  const inFlight = Boolean(started) && !done;

  return (
    <Frame variant="ghost">
      <FrameHeader className="flex-row items-center justify-between gap-3">
        <FrameTitle>Noddle</FrameTitle>
        {canUpdate && !inFlight ? (
          <Button
            disabled={launch.isPending || !data?.updatable}
            onClick={handleClick}
            size="xs"
            variant="outline"
          >
            {data?.updatable ? "Update" : "Up to date"}
          </Button>
        ) : null}
      </FrameHeader>

      <FramePanel className="space-y-3">
        <dl className="space-y-1.5 text-xs">
          <div className="flex items-center gap-3">
            <dt className="min-w-0 flex-1 text-muted-foreground">Running</dt>
            <dd>
              <Commit sha={running} version={data?.runningVersion} />
            </dd>
          </div>
          <div className="flex items-center gap-3">
            <dt className="min-w-0 flex-1 text-muted-foreground">Available</dt>
            <dd>
              <Commit
                sha={data?.remoteCommit ?? null}
                version={data?.remoteVersion}
              />
            </dd>
          </div>
        </dl>

        <UpdateNotes
          data={data}
          done={done}
          failed={failed}
          inFlight={inFlight}
          running={running}
        />

        {data?.log ? (
          <div className="rounded-md bg-muted">
            <pre className="no-scrollbar scroll-fade max-h-48 overflow-auto p-3 font-mono text-[11px] leading-relaxed">
              {data.log.replace(ANSI, "")}
            </pre>
          </div>
        ) : null}
      </FramePanel>
    </Frame>
  );
}
