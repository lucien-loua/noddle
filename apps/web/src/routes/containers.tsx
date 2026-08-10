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
import { IconTile } from "@/components/ui/icon-tile";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { type RoleName, roles } from "@/lib/permissions";
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

function KindIcon({ kind }: { kind: ContainerKind }) {
  const Icon = KIND_ICON[kind];
  return (
    <IconTile size="sm" variant="frame">
      <Icon weight="duotone" />
    </IconTile>
  );
}

function KindBadge({ kind }: { kind: ContainerKind }) {
  return (
    <Badge variant={kind === "control-plane" ? "secondary" : "outline"}>
      {KIND_LABEL[kind]}
    </Badge>
  );
}

/** `running` reads at a glance; everything else is worth reading. */
function StateCell({ row }: { row: ContainerRow }) {
  const running = row.state === "running";
  return (
    <span className={running ? "" : "text-muted-foreground"}>{row.status}</span>
  );
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
              <CubeIcon className="size-5" weight="duotone" />
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
        // `Frame` + `FramePanel`: the table sits INSIDE a panel rather than
        // bare on the background. `p-0` because the panel pads its content
        // by default, and a table must touch its own edges — it carries its
        // own spacing, row by row.
        <Frame variant="ghost">
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
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Image</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Server</TableHead>
                  <TableHead className="text-end">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {view.containers.map((row) => (
                  <TableRow key={`${row.serverId}-${row.id}`}>
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-3">
                        <KindIcon kind={row.kind} />
                        <span className="min-w-0 truncate">{row.name}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <KindBadge kind={row.kind} />
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {row.image}
                    </TableCell>
                    <TableCell>
                      <StateCell row={row} />
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {row.serverName}
                    </TableCell>
                    <TableCell className="text-end">
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
