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

function railpackHint(report: ServerToolReport): string | undefined {
  if (!report.railpack || report.railpack.includes(report.railpackExpected)) {
    return;
  }
  return `expected ${report.railpackExpected}`;
}

function swarmHint(report: ServerToolReport): string | undefined {
  return report.swarm === "active" ? undefined : "expected active";
}

function toolchainHealthy(report: ServerToolReport): boolean {
  return (
    report.docker !== null &&
    report.railpack !== null &&
    railpackHint(report) === undefined &&
    swarmHint(report) === undefined
  );
}

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

export function ServerToolchain({
  reachable,
  role,
  serverId,
}: {
  reachable: boolean;
  role: RoleName | null;
  serverId: string;
}) {
  const canSetup = useCan(role, "server", "create");

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
