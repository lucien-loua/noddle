import {
  CirclesThreeIcon,
  CubeIcon,
  ShieldCheckIcon,
} from "@phosphor-icons/react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useCallback, useState } from "react";

import { AppShell } from "@/components/app-shell";
import { ContainerActions } from "@/components/container-actions";
import { IconStack } from "@/components/icon-stack";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Empty,
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { dotClass } from '@/lib/format';
import type { Tone } from '@/lib/format';
import { roles } from '@/lib/permissions';
import type { RoleName } from '@/lib/permissions';
import { getAuthState } from "@/server/auth";
import type { ContainerKind, ContainerRow } from "@/server/containers";
import { getContainers } from "@/server/containers";

export const Route = createFileRoute("/containers")({
  beforeLoad: async () => {
    const state = await getAuthState();
    if (!state.signedIn) {
      throw redirect({ to: "/login" });
    }
    return { email: state.email, role: state.role };
  },
  component: ContainersPage,
  loader: async ({ context }) => ({
    email: context.email,
    role: context.role,
    view: await getContainers(),
  }),
});

/**
 * What the kind MEANS, in one word.
 *
 * Labeling isn't decorative here: it's what prevents offering a no-op
 * action on a Swarm task, or a destructive one on the control plane. The
 * word comes before the actions, and it explains them.
 */
const KIND_LABEL: Record<ContainerKind, string> = {
  "control-plane": "Noddle",
  swarm: "Swarm task",
  unmanaged: "Unmanaged",
};

/**
 * The icon says the SAME thing as the badge, ahead of the word.
 *
 * The shield isn't decorative: it's the row you're not allowed to touch,
 * and it's the only kind whose lack of actions needs an explanation.
 */
const KIND_ICON: Record<ContainerKind, typeof CubeIcon> = {
  "control-plane": ShieldCheckIcon,
  swarm: CirclesThreeIcon,
  unmanaged: CubeIcon,
};

function KindBadge({ kind }: { kind: ContainerKind }) {
  const Icon = KIND_ICON[kind];
  return (
    <Badge variant={kind === "control-plane" ? "secondary" : "outline"}>
      <Icon data-icon="inline-start" />
      {KIND_LABEL[kind]}
    </Badge>
  );
}

/**
 * The one thing this page is scanned for.
 *
 * The status STRING stays Docker's, unparsed — except for the health
 * suffix, which is a substring test rather than a number, and which is the
 * difference between a container that answers and one that does not.
 *
 * An `exited` container is NOT red. A finished Swarm task replica leaves
 * one behind on every deploy, and without an exit code in the row we
 * cannot tell that from a crash — colouring the common case red would
 * teach you to ignore the colour.
 */
function containerTone(row: ContainerRow): Tone {
  if (row.state === "running") {
    return row.status.includes("(unhealthy)") ? "danger" : "ok";
  }
  if (row.state === "dead") {
    return "danger";
  }
  if (row.state === "restarting") {
    return "busy";
  }
  return "neutral";
}

function ContainersPage() {
  const { email, role, view } = Route.useLoaderData();
  const known = role && role in roles ? (role as RoleName) : null;
  const [failed, setFailed] = useState<string | null>(null);
  const handleError = useCallback((m: string) => setFailed(m), []);

  return (
    <AppShell email={email} role={role} title="Containers">
      {/* A silent machine is a FACT, not a missing row: without this the
          screen would assert it has nothing on it. `div` and not `p` in the
          list: `AlertDescription`'s paragraph-spacing rule targets `p`, and
          would bloat a list of statuses into prose. */}
      {view.unreachable.length > 0 ? (
        <Alert className="mb-4" variant="destructive">
          <AlertDescription className="space-y-1">
            {view.unreachable.map((s) => (
              <div key={s.serverId}>
                <span className="font-medium text-foreground">
                  {s.serverName}
                </span>{" "}
                did not answer: {s.reason}
              </div>
            ))}
          </AlertDescription>
        </Alert>
      ) : null}

      {/* A server refusal — "it's a Swarm task", "it's part of Noddle" — is
          shown here in full rather than disappearing: it's the only way to
          learn WHY the action didn't happen. */}
      {failed ? (
        <Alert className="mb-4" variant="destructive">
          <AlertDescription>{failed}</AlertDescription>
        </Alert>
      ) : null}

      {view.containers.length === 0 ? (
        <Empty className="h-full">
          <EmptyMedia>
            <IconStack>
              <CubeIcon className="size-5" />
            </IconStack>
          </EmptyMedia>
          <EmptyHeader>
            <EmptyTitle>Nothing running</EmptyTitle>
            <EmptyDescription>
              Containers on every connected server show up here, including ones
              Noddle did not deploy.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        // Cards are direct children of the Frame, like every other list:
        // each one IS a panel, so wrapping them in another produced a panel
        // inside a panel.
        <Frame className="w-full" variant="ghost">
          <FrameHeader>
            <FrameTitle>All nodes</FrameTitle>
            <FrameDescription>
              Every container across every connected server — Swarm services,
              Noddle's own control plane, and anything else running underneath.
            </FrameDescription>
          </FrameHeader>
          <FramePanel className="p-0">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Container</TableHead>
                  <TableHead className="w-56">Status</TableHead>
                  <TableHead className="hidden w-32 md:table-cell">
                    Kind
                  </TableHead>
                  <TableHead className="hidden lg:table-cell">Image</TableHead>
                  <TableHead className="hidden w-40 md:table-cell">
                    Server
                  </TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {view.containers.map((row) => (
                  <TableRow key={`${row.serverId}-${row.id}`}>
                    {/* Two lines: a Swarm task's name is its SERVICE plus
                        25 random characters, and the service is the half
                        you read. Two replicas then differ only where they
                        actually differ. */}
                    <TableCell className="min-w-0">
                      <span className="flex min-w-0 items-center gap-2">
                        <span
                          aria-hidden
                          className={`size-2 shrink-0 rounded-full ${dotClass(containerTone(row))}`}
                        />
                        <span className="min-w-0 truncate font-medium">
                          {row.serviceName ?? row.name}
                        </span>
                      </span>
                      {row.serviceName ? (
                        <span className="block truncate pl-4 font-mono text-muted-foreground text-xs">
                          {row.name}
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell
                      className={
                        row.state === "running"
                          ? "text-sm"
                          : "text-muted-foreground text-sm"
                      }
                    >
                      {row.status}
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      <KindBadge kind={row.kind} />
                    </TableCell>
                    <TableCell className="hidden max-w-0 truncate font-mono text-muted-foreground text-xs lg:table-cell">
                      {row.image}
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground text-sm md:table-cell">
                      {row.serverName}
                    </TableCell>
                    <TableCell>
                      <ContainerActions
                        onError={handleError}
                        role={known}
                        row={row}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </FramePanel>
        </Frame>
      )}
    </AppShell>
  );
}
