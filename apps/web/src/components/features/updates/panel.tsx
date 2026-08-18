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

/**
 * The polling cadence once the update is launched.
 *
 * Five seconds: an update takes minutes (building both images, migrations,
 * restart), and for half of that time the server doesn't respond at all.
 * Polling faster would only stack up requests that fail during the
 * restart.
 */
const POLL_MS = 5000;

/** Enough to recognize a commit without spelling out forty characters. */
const SHORT = 12;

/**
 * ANSI color sequences.
 *
 * `install.sh` colors its step titles and final banner, and buildx emits
 * them even under `--progress=plain`. Without cleanup, the panel displays
 * "\x1b[1m▸ Migrations\x1b[0m". The cleanup happens here, at DISPLAY time, as
 * with build logs: the file on the host must stay the exact byte the
 * machine produced, since it's what gets read back afterward.
 */
// oxlint-disable-next-line no-control-regex -- this is precisely the ESC character we're targeting
const ANSI = /\u001B\[[0-9;]*m/g;

function Commit({ sha }: { sha: string | null }) {
  if (!sha) {
    return <span className="text-muted-foreground">unknown</span>;
  }
  return <span className="font-mono text-xs">{sha.slice(0, SHORT)}</span>;
}

/**
 * The five notes an update can carry — unreachable, unstamped, failed, in
 * flight, done. Split out of `UpdatePanel` because they are what made it read
 * as branchy: five conditionals in a row, none of them about the panel's
 * structure.
 */
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
      {/* An unreachable machine is a FACT, not a broken page: the rest of
          the server screen stays useful, and "we don't know" is stated. */}
      {data?.unreachable ? (
        <FrameDescription>
          Could not reach the manager to check for updates: {data.unreachable}
        </FrameDescription>
      ) : null}

      {running === null && !data?.unreachable ? (
        <FrameDescription>
          {data?.remoteCommit
            ? "This installation predates version stamping, so Noddle cannot tell how far behind it is. Updating is safe either way — the installer is idempotent."
            : "This process was not built by the installer, so it carries no version. Updating from here is only meaningful on an installed machine."}
        </FrameDescription>
      ) : null}

      {failed ? (
        <output className="block text-destructive text-xs">{failed}</output>
      ) : null}

      {inFlight ? (
        <FrameDescription role="status">
          Updating. The dashboard restarts partway through, so this page will
          stop responding for a moment — it comes back on its own.
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
  // Courtesy only: `startUpdate` re-checks the permission server-side.
  const canUpdate = useCan(role, "installation", "update");
  const [started, setStarted] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const status = useQuery<UpdateStatus>({
    queryFn: () => getUpdateStatus(),
    queryKey: queries.updateStatus().queryKey,
    // We only poll once the update is launched. The rest of the time a
    // single read is enough — and it opens an SSH session, which we don't
    // do every five seconds for nothing.
    refetchInterval: started ? POLL_MS : false,
    // During the container restart, the request fails: that's expected,
    // and above all it's not a reason to give up on polling.
    retry: true,
  });

  const launch = useMutation({
    mutationFn: () => startUpdate(),
    onError: (e: Error) => setFailed(errorMessage(e, "could not start")),
    onSuccess: () => {
      setFailed(null);
      // The commit that was running BEFORE: that's what serves as the
      // witness. The update is finished when the version reported by the
      // server differs from it — not when the command returned 0, which
      // says nothing about what's actually running.
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
            {/* "Up to date" is written ONLY if both versions are known and
                coincide. An installation from before `NODDLE_COMMIT` reports
                nothing: writing "up to date" for it would be wrong on the
                machine that most needs updating. It reads "Update" instead,
                and the fact that we don't know is stated right below. */}
            {data?.updatable ? "Update" : "Up to date"}
          </Button>
        ) : null}
      </FrameHeader>

      <FramePanel className="space-y-3">
        <dl className="space-y-1.5 text-xs">
          <div className="flex items-center gap-3">
            <dt className="min-w-0 flex-1 text-muted-foreground">Running</dt>
            <dd>
              <Commit sha={running} />
            </dd>
          </div>
          <div className="flex items-center gap-3">
            <dt className="min-w-0 flex-1 text-muted-foreground">Available</dt>
            <dd>
              <Commit sha={data?.remoteCommit ?? null} />
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

        {/* The log lives on the HOST, so it survives the restart that cuts
            off this page. It's the only reliable account of what happened.

            TWO elements, and this isn't decorative: `scroll-fade` is a
            `mask-image`, so it eats into the BACKGROUND of the element that
            carries it — background and radius included, not just the text.
            The frame therefore stays outside, and only the scrolling part
            is masked. A lesson already paid for on `TabsList` and on a
            bordered table.

            The fade is driven by `scroll(self y)`: it must be set on the
            scroll container ITSELF, not on its parent. And it only triggers
            if there's actually something to scroll, so a short log isn't
            clipped. */}
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
