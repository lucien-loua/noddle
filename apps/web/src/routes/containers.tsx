/**
 * biome-ignore-all lint/performance/noJsxPropsBind: three filter controls;
 * a wrapper per setState adds noise without a shared child to hoist.
 */
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { dotClass } from "@/lib/format";
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

/** Docker's own word, capitalised for a menu — never translated: it is the
 *  same string the Status column shows. */
function stateLabel(state: string): string {
  return state.charAt(0).toUpperCase() + state.slice(1);
}

function matches(row: ContainerRow, needle: string): boolean {
  return [row.name, row.serviceName ?? "", row.image, row.serverName].some(
    (field) => field.toLowerCase().includes(needle)
  );
}

/**
 * One row, extracted so the click that opens the drawer is a stable
 * callback rather than a new closure per render per row.
 */
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
  // The actions cell is INSIDE the clickable row: without this, opening
  // the menu also opens the drawer behind it — and Enter on the trigger
  // would do both at once.
  const stopRowActivation = useCallback(
    (event: KeyboardEvent<HTMLElement> | MouseEvent<HTMLElement>) => {
      event.stopPropagation();
    },
    []
  );

  return (
    <TableRow
      className="cursor-pointer focus-visible:bg-muted focus-visible:outline-none"
      onClick={handleSelect}
      onKeyDown={handleKeyDown}
      tabIndex={0}
    >
      {/* Two lines: a Swarm task's name is its SERVICE plus 25 random
          characters, and the service is the half you read. Two replicas
          then differ only where they actually differ.

          The whole ROW is the way in: everything it cannot hold — ports,
          mounts, networks, its output — is one click away, and a row that
          opened nothing was this page's real gap. */}
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
      {/* Docker's own summary, kept whole: "0.0.0.0:5432->5432/tcp" says
          published, "5432/tcp" says exposed only, and rewriting it would
          lose that distinction. */}
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

  // Base UI hands back `null` when a Select is cleared; "all" IS this
  // filter's cleared state, and there is no third one.
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

  // The two lists come from the ROWS, not from a constant: Docker has a
  // dozen states and an installation shows three of them. A filter that
  // can only ever select nothing is worse than no filter.
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
        // One frame, stacked: the filter bar is a TOOLBAR over the table,
        // not a second card sitting above it. Every panel is therefore a
        // direct child, which is what the join is keyed on.
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
            {/* Only when there is more than one machine: on a single-server
                installation this control can only ever say "all". */}
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
