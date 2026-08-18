import { useMutation, useQuery } from "@tanstack/react-query";
import { useCallback } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Frame,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@/components/ui/frame";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { errorMessage } from "@/lib/format";
import type { RoleName } from "@/lib/permissions";
import { queries } from "@/lib/queries";
import { useCan } from "@/lib/use-permission";
import type { ServerToolReport } from "@/server/servers";
import { setupServer } from "@/server/servers";

function ToolRow({
  hint,
  name,
  version,
}: {
  /** What is wrong with an otherwise present tool. */
  hint?: string;
  name: string;
  version: string | null;
}) {
  return (
    <FramePanel className="flex items-center justify-between gap-3 text-sm">
      <span className="font-medium">{name}</span>
      {version ? (
        <span className="flex items-center gap-2">
          <span className="text-muted-foreground">{version}</span>
          {hint ? <Badge variant="outline">{hint}</Badge> : null}
        </span>
      ) : (
        <Badge variant="destructive">missing</Badge>
      )}
    </FramePanel>
  );
}

/**
 * A version other than the one Noddle installs is worth seeing: the
 * project's build rules were measured on a specific Railpack, so a machine
 * running another one can build differently for no visible reason.
 */
function railpackHint(report: ServerToolReport): string | undefined {
  if (!report.railpack || report.railpack.includes(report.railpackExpected)) {
    return;
  }
  return `expected ${report.railpackExpected}`;
}

/**
 * Swarm is compared EXACTLY, not by substring.
 *
 * `LocalNodeState` answers `inactive` on a node that never joined — and
 * `"inactive".includes("active")` is true, so the substring test used for
 * versions would have called the broken case healthy.
 */
function swarmHint(report: ServerToolReport): string | undefined {
  return report.swarm === "active" ? undefined : "expected active";
}

/** Nothing to repair: every tool is there, at the version we install. */
function toolchainHealthy(report: ServerToolReport): boolean {
  return (
    report.docker !== null &&
    report.railpack !== null &&
    railpackHint(report) === undefined &&
    swarmHint(report) === undefined
  );
}

/** Why there is no report — the three reasons are not the same thing. */
function unreadable(
  fetching: boolean,
  reachable: boolean,
  error: unknown
): string {
  if (fetching) {
    return "Asking the machine…";
  }
  if (!reachable) {
    return "This server is unreachable, so its tools cannot be read. Check once it answers again.";
  }
  if (error) {
    return errorMessage(error, "could not reach this server");
  }
  return "No answer yet.";
}

/**
 * What this machine can actually do, and a way to fix it.
 *
 * A server added by adoption never ran provisioning, so it can clone and
 * fail to build. Without this the gap only shows up as `command not found`
 * inside a deployment, which reads as a build problem rather than a machine
 * that was never finished.
 */
export function ServerToolchain({
  reachable,
  role,
  serverId,
}: {
  /** An unreachable machine would make every visit wait on an SSH
   *  timeout, so the check waits to be asked. */
  reachable: boolean;
  role: RoleName | null;
  serverId: string;
}) {
  const canSetup = useCan(role, "server", "create");

  // A query and not a mutation: the answer belongs to the page, so it
  // arrives with it and survives a reload. It used to live in component
  // state — you checked, reloaded, and had to check again.
  const check = useQuery({
    ...queries.serverTools(serverId),
    enabled: reachable,
  });
  const report = check.data ?? null;

  const setup = useMutation({
    mutationFn: () => setupServer({ data: { serverId } }),
    onError: (e: Error) =>
      toast.add({
        description: errorMessage(e, "could not start the setup"),
        title: "Setup failed",
        type: "error",
      }),
    onSuccess: () =>
      toast.add({
        description:
          "The worker will install Docker, join this machine to the Swarm and install Railpack, each one only if it is missing. Re-check once it finishes.",
        title: "Setup queued",
        type: "success",
      }),
  });

  const handleCheck = useCallback(() => {
    check.refetch();
  }, [check]);
  const handleSetup = useCallback(() => setup.mutate(), [setup]);

  return (
    // Same shape as the Overview block on this page: the section's `h2`
    // names the subject, the frame's header names the block and carries
    // its actions.
    <Frame stacked variant="ghost">
      <FrameHeader className="flex-row items-center justify-between gap-3">
        <FrameTitle>Installed tools</FrameTitle>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            disabled={check.isFetching}
            onClick={handleCheck}
            size="sm"
            variant="outline"
          >
            {check.isFetching ? <Spinner data-icon="inline-start" /> : null}
            {report ? "Re-check" : "Check"}
          </Button>
          {/* Nothing to repair, nothing to offer: running setup on a
              healthy machine is a no-op that still touches it. The button
              comes back the moment a tool is missing, drifted or the node
              is out of the Swarm — and it stays available when there is no
              report at all, which is exactly when a machine may be the
              thing that is broken. */}
          {canSetup && !(report && toolchainHealthy(report)) ? (
            <Button
              disabled={setup.isPending}
              onClick={handleSetup}
              size="sm"
              variant="outline"
            >
              {setup.isPending ? <Spinner data-icon="inline-start" /> : null}
              Run setup
            </Button>
          ) : null}
        </div>
      </FrameHeader>
      {/* A fragment and not a wrapper: `stacked` joins panels through
          adjacency on DIRECT children, so any element around them would
          undo the join. */}
      {report ? (
        <>
          <ToolRow name="Docker" version={report.docker} />
          <ToolRow
            hint={railpackHint(report)}
            name="Railpack"
            version={report.railpack}
          />
          <ToolRow
            hint={swarmHint(report)}
            name="Swarm"
            version={report.swarm}
          />
        </>
      ) : (
        <FramePanel className="text-muted-foreground text-sm">
          {unreadable(check.isFetching, reachable, check.error)}
        </FramePanel>
      )}
    </Frame>
  );
}
