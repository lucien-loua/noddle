import {
  CirclesThreeIcon,
  CubeIcon,
  MagnifyingGlassIcon,
  ShieldCheckIcon,
} from "@phosphor-icons/react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import type { KeyboardEvent, MouseEvent } from "react";
import { useCallback, useMemo, useState } from "react";

import { AppShell } from "@/components/app-shell";
import { ContainerActions } from "@/components/container-actions";
import { ContainerDrawer } from "@/components/features/containers/container-drawer";
import { IconStack } from "@/components/icon-stack";
import { useTerminalDialog } from "@/components/terminal-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StatusIndicator } from "@/components/ui/status";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { Tone } from "@/lib/format";
import { roles } from "@/lib/permissions";
import type { RoleName } from "@/lib/permissions";
import { useCan } from "@/lib/use-permission";
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

const KIND_LABEL: Record<ContainerKind, string> = {
  "control-plane": "Noddle",
  swarm: "Swarm task",
  unmanaged: "Unmanaged",
};

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

function stateLabel(state: string): string {
  return state.charAt(0).toUpperCase() + state.slice(1);
}

function matches(row: ContainerRow, needle: string): boolean {
  return [row.name, row.serviceName ?? "", row.image, row.serverName].some(
    (field) => field.toLowerCase().includes(needle)
  );
}

function ContainerTableRow({
  onError,
  onSelect,
  onTerminal,
  role,
  row,
}: {
  onError: (message: string) => void;
  onSelect: (row: ContainerRow) => void;
  onTerminal: ((row: ContainerRow) => void) | null;
  role: RoleName | null;
  row: ContainerRow;
}) {
  const handleSelect = useCallback(() => onSelect(row), [onSelect, row]);
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTableRowElement>) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onSelect(row);
      }
    },
    [onSelect, row]
  );
  const stopRowActivation = useCallback(
    (event: KeyboardEvent<HTMLElement> | MouseEvent<HTMLElement>) => {
      event.stopPropagation();
    },
    []
  );

  return (
    <TableRow
      aria-label={`Open ${row.serviceName ?? row.name}`}
      className="cursor-pointer focus-visible:bg-muted focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2"
      onClick={handleSelect}
      onKeyDown={handleKeyDown}
      tabIndex={0}
    >
      <TableCell className="min-w-0">
        <span className="flex min-w-0 items-center gap-2">
          <StatusIndicator tone={containerTone(row)} />
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
          row.state === "running" ? "text-sm" : "text-muted-foreground text-sm"
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
      <TableCell className="hidden max-w-0 truncate font-mono text-muted-foreground text-xs xl:table-cell">
        {row.ports || "—"}
      </TableCell>
      <TableCell className="hidden text-muted-foreground text-sm md:table-cell">
        {row.serverName}
      </TableCell>
      <TableCell onClick={stopRowActivation} onKeyDown={stopRowActivation}>
        <ContainerActions
          onError={onError}
          onTerminal={onTerminal}
          role={role}
          row={row}
        />
      </TableCell>
    </TableRow>
  );
}

function ContainersPage() {
  const { email, role, view } = Route.useLoaderData();
  const known = role && role in roles ? (role as RoleName) : null;
  const [failed, setFailed] = useState<string | null>(null);
  const handleError = useCallback((m: string) => setFailed(m), []);

  const [search, setSearch] = useState("");
  const [state, setState] = useState("all");
  const [serverId, setServerId] = useState("all");
  const [selected, setSelected] = useState<ContainerRow | null>(null);

  const canShell = useCan(known, "container", "shell");
  const { openTerminal, terminal } = useTerminalDialog();

  const handleTerminal = useCallback(
    (row: ContainerRow) => {
      openTerminal({
        containerId: row.id,
        kind: "container",
        serverId: row.serverId,
        target: "container",
        title: row.name,
      });
    },
    [openTerminal]
  );

  const handleState = useCallback((next: string | null) => {
    setState(next ?? "all");
  }, []);
  const handleServerId = useCallback((next: string | null) => {
    setServerId(next ?? "all");
  }, []);

  const handleDrawer = useCallback((open: boolean) => {
    if (!open) {
      setSelected(null);
    }
  }, []);

  const states = useMemo(
    () => [...new Set(view.containers.map((row) => row.state))].toSorted(),
    [view.containers]
  );
  const servers = useMemo(() => {
    const byId = new Map<string, string>();
    for (const row of view.containers) {
      byId.set(row.serverId, row.serverName);
    }
    return [...byId.entries()];
  }, [view.containers]);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return view.containers.filter((row) => {
      if (state !== "all" && row.state !== state) {
        return false;
      }
      if (serverId !== "all" && row.serverId !== serverId) {
        return false;
      }
      return needle.length === 0 || matches(row, needle);
    });
  }, [search, serverId, state, view.containers]);

  const filtering = search !== "" || state !== "all" || serverId !== "all";
  const clearFilters = useCallback(() => {
    setSearch("");
    setState("all");
    setServerId("all");
  }, []);

  return (
    <AppShell email={email} role={role} title="Containers">
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

      {failed ? (
        <Alert className="mb-4" variant="destructive">
          <AlertDescription>{failed}</AlertDescription>
        </Alert>
      ) : null}

      {view.containers.length === 0 ? (
        <Frame className="flex h-full min-h-0 flex-col" variant="ghost">
          <FramePanel className="flex min-h-0 flex-1 flex-col">
            <Empty className="min-h-0 flex-1 border-0">
              <EmptyHeader>
                <EmptyMedia>
                  <IconStack>
                    <CubeIcon className="size-5" />
                  </IconStack>
                </EmptyMedia>
                <EmptyTitle>Nothing running</EmptyTitle>
                <EmptyDescription>
                  Containers on every connected server show up here, including
                  ones Noddle did not deploy.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          </FramePanel>
        </Frame>
      ) : (
        <Frame className="w-full" stacked variant="ghost">
          <FrameHeader>
            <FrameTitle className="flex items-center gap-2">
              All nodes
              <Badge variant="outline">
                {filtering
                  ? `${visible.length} of ${view.containers.length}`
                  : view.containers.length}
              </Badge>
            </FrameTitle>
            <FrameDescription>
              Every container across every connected server: Swarm services,
              Noddle&apos;s own control plane, and anything else running
              underneath.
            </FrameDescription>
          </FrameHeader>

          <FramePanel className="flex flex-wrap items-center gap-2">
            <InputGroup className="min-w-56 flex-1">
              <InputGroupAddon>
                <MagnifyingGlassIcon />
              </InputGroupAddon>
              <InputGroupInput
                aria-label="Search containers"
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search by name, service, image, server…"
                value={search}
              />
            </InputGroup>
            <Select
              items={Object.fromEntries([
                ["all", "All states"],
                ...states.map((s) => [s, stateLabel(s)]),
              ])}
              onValueChange={handleState}
              value={state}
            >
              <SelectTrigger aria-label="Filter by state" className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="all">All states</SelectItem>
                  {states.map((s) => (
                    <SelectItem key={s} value={s}>
                      {stateLabel(s)}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            {servers.length > 1 ? (
              <Select
                items={Object.fromEntries([
                  ["all", "All servers"],
                  ...servers.map(([id, name]) => [id, name]),
                ])}
                onValueChange={handleServerId}
                value={serverId}
              >
                <SelectTrigger aria-label="Filter by server" className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="all">All servers</SelectItem>
                    {servers.map(([id, name]) => (
                      <SelectItem key={id} value={id}>
                        {name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            ) : null}
            {filtering ? (
              <Button onClick={clearFilters} size="sm" variant="ghost">
                Clear
              </Button>
            ) : null}
          </FramePanel>

          {visible.length === 0 ? (
            <FramePanel className="flex min-h-0 flex-1 flex-col">
              <Empty className="min-h-0 flex-1 border-0">
                <EmptyHeader>
                  <EmptyMedia>
                    <IconStack>
                      <CubeIcon className="size-5" />
                    </IconStack>
                  </EmptyMedia>
                  <EmptyTitle>No container matches</EmptyTitle>
                  <EmptyDescription>
                    Nothing on the connected servers answers these filters.
                  </EmptyDescription>
                </EmptyHeader>
                <Button onClick={clearFilters} size="sm" variant="outline">
                  Clear filters
                </Button>
              </Empty>
            </FramePanel>
          ) : (
            <FramePanel className="p-0">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Container</TableHead>
                    <TableHead className="w-56">Status</TableHead>
                    <TableHead className="hidden w-32 md:table-cell">
                      Kind
                    </TableHead>
                    <TableHead className="hidden lg:table-cell">
                      Image
                    </TableHead>
                    <TableHead className="hidden w-48 xl:table-cell">
                      Ports
                    </TableHead>
                    <TableHead className="hidden w-40 md:table-cell">
                      Server
                    </TableHead>
                    <TableHead className="w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visible.map((row) => (
                    <ContainerTableRow
                      key={`${row.serverId}-${row.id}`}
                      onError={handleError}
                      onSelect={setSelected}
                      onTerminal={canShell ? handleTerminal : null}
                      role={known}
                      row={row}
                    />
                  ))}
                </TableBody>
              </Table>
            </FramePanel>
          )}
        </Frame>
      )}

      <ContainerDrawer onOpenChange={handleDrawer} row={selected} />
      {terminal}
    </AppShell>
  );
}
