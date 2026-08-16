import { useMutation } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { errorMessage } from "@/lib/format";
import type { RoleName } from "@/lib/permissions";
import { useCan } from "@/lib/use-permission";
import {
  checkServerTools,
  type ServerToolReport,
  setupServer,
} from "@/server/servers";

function ToolRow({
  expected,
  name,
  version,
}: {
  expected?: string;
  name: string;
  version: string | null;
}) {
  // A version that differs from the one Noddle installs is worth seeing:
  // the project's build rules were measured on a specific railpack, so a
  // machine running another one can build differently for no visible reason.
  const drifted = Boolean(expected && version && !version.includes(expected));

  return (
    <div className="flex items-center justify-between gap-3 py-1.5 text-sm">
      <span className="font-medium">{name}</span>
      {version ? (
        <span className="flex items-center gap-2">
          <span className="text-muted-foreground">{version}</span>
          {drifted ? (
            <Badge variant="outline">expected {expected}</Badge>
          ) : null}
        </span>
      ) : (
        <Badge variant="destructive">missing</Badge>
      )}
    </div>
  );
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
  role,
  serverId,
}: {
  role: RoleName | null;
  serverId: string;
}) {
  const canSetup = useCan(role, "server", "create");
  const [report, setReport] = useState<ServerToolReport | null>(null);

  const check = useMutation({
    mutationFn: () => checkServerTools({ data: { serverId } }),
    onError: (e: Error) =>
      toast.add({
        description: errorMessage(e, "could not reach this server"),
        title: "Check failed",
        type: "error",
      }),
    onSuccess: setReport,
  });

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
          "Docker, the Swarm join and railpack are installed if missing. Check again once it finishes.",
        title: "Setup queued",
        type: "success",
      }),
  });

  const handleCheck = useCallback(() => check.mutate(), [check]);
  const handleSetup = useCallback(() => setup.mutate(), [setup]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          disabled={check.isPending}
          onClick={handleCheck}
          variant="outline"
        >
          {check.isPending ? <Spinner data-icon="inline-start" /> : null}
          Check
        </Button>
        {canSetup ? (
          <Button
            disabled={setup.isPending}
            onClick={handleSetup}
            variant="outline"
          >
            {setup.isPending ? <Spinner data-icon="inline-start" /> : null}
            Run setup
          </Button>
        ) : null}
      </div>

      {report ? (
        <div className="rounded-2xl border px-4 py-2">
          <ToolRow name="Docker" version={report.docker} />
          <ToolRow
            expected={report.railpackExpected}
            name="Railpack"
            version={report.railpack}
          />
          <ToolRow name="Swarm" version={report.swarm} />
        </div>
      ) : null}
    </div>
  );
}
