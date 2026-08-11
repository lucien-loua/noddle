import type { DatabaseEngine } from "@noddle/shared/database-engines";
import {
  ArrowClockwiseIcon,
  CodeIcon,
  DatabaseIcon,
  DotsThreeIcon,
  MagnifyingGlassIcon,
  PlayIcon,
  RocketLaunchIcon,
  StackIcon,
  StopIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouter } from "@tanstack/react-router";
import type { ChangeEvent } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ConfirmNameDialog } from "@/components/confirm-name-dialog";
import { DatabaseMark } from "@/components/features/database/database-mark";
import { IconStack } from "@/components/icon-stack";
import { MoveServiceDialog } from "@/components/move-service-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { IconTile } from "@/components/ui/icon-tile";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { cache } from "@/lib/cache";
import {
  badgeVariant,
  dotClass,
  errorMessage,
  serviceLabel,
} from "@/lib/format";
import type { RoleName } from "@/lib/permissions";
import { queries } from "@/lib/queries";
import { useCan } from "@/lib/use-permission";
import type { ProjectGroup, Scope } from "@/server/dashboard";
import { deleteDatabase, triggerDatabaseLifecycle } from "@/server/databases";
import { triggerDeploy, triggerLifecycle } from "@/server/deployments";
import { deleteService } from "@/server/services";
import { deleteStack, triggerStackDeploy } from "@/server/stacks";

type Kind = "database" | "service" | "stack";
type SortKey = "name" | "status";
type TypeFilter = "all" | Kind;
type LifecycleAction = "restart" | "start" | "stop";

const SCOPE_POLL_MS = 2000;
const AWAITING_TIMEOUT_MS = 60_000;

interface GridItem {
  domain: string | null;
  /** The engine, for databases only: it's what selects the mark. */
  engine?: DatabaseEngine;
  id: string;
  kind: Kind;
  lastError: string | null;
  name: string;
  serverName: string;
  status: string;
}

interface MoveTarget {
  environmentId: string;
  id: string;
  name: string;
}

interface AwaitingEntry {
  since: number;
  status: string;
}

/** The selection key: composite, because three tables can theoretically
 *  share the same UUID and we need to know which `deleteX` to call. */
function itemKey(item: { id: string; kind: Kind }): string {
  return `${item.kind}:${item.id}`;
}

function scopeHasDeleting(scope: Scope): boolean {
  return (
    scope.services.some((s) => s.status === "deleting") ||
    scope.stacks.some((s) => s.status === "deleting") ||
    scope.databases.some((d) => d.status === "deleting")
  );
}

function statusInScope(scope: Scope, key: string): string | undefined {
  const colon = key.indexOf(":");
  const kind = key.slice(0, colon) as Kind;
  const id = key.slice(colon + 1);
  if (kind === "service") {
    return scope.services.find((s) => s.id === id)?.status;
  }
  if (kind === "stack") {
    return scope.stacks.find((s) => s.id === id)?.status;
  }
  return scope.databases.find((d) => d.id === id)?.status;
}

/**
 * Drop awaiting entries once the resource status moved off the snapshot,
 * the row disappeared, or the timeout elapsed — no new statuses needed.
 */
function refineAwaiting(
  scope: Scope,
  awaiting: Map<string, AwaitingEntry>
): Map<string, AwaitingEntry> {
  if (awaiting.size === 0) {
    return awaiting;
  }
  const now = Date.now();
  const next = new Map<string, AwaitingEntry>();
  for (const [key, entry] of awaiting) {
    if (now - entry.since > AWAITING_TIMEOUT_MS) {
      continue;
    }
    const current = statusInScope(scope, key);
    if (current === undefined || current !== entry.status) {
      continue;
    }
    next.set(key, entry);
  }
  return next.size === awaiting.size ? awaiting : next;
}

function shouldPoll(
  scope: Scope | undefined,
  awaiting: Map<string, AwaitingEntry>
): boolean {
  if (!scope) {
    return false;
  }
  return awaiting.size > 0 || scopeHasDeleting(scope);
}

/**
 * The lifecycle applies to services AND databases, never to stacks.
 *
 * A stack is SEVERAL Swarm services under the same namespace: scaling it
 * to zero replicas would require iterating over them one by one, and
 * `runLifecycle` has nothing for that today. Better not to offer the
 * action than to offer one that would only touch one container out of
 * three.
 */
function hasLifecycle(kind: Kind): boolean {
  return kind === "service" || kind === "database";
}

/** A deployment rebuilds an image. A database doesn't have one. */
function hasDeploy(kind: Kind): boolean {
  return kind === "service" || kind === "stack";
}

/** The same call, routed by type: two server functions, one intention. */
function runLifecycleFor(
  item: GridItem,
  action: LifecycleAction
): Promise<unknown> {
  if (item.kind === "database") {
    return triggerDatabaseLifecycle({
      data: { action, databaseId: item.id },
    });
  }
  return triggerLifecycle({ data: { action, serviceId: item.id } });
}

/**
 * The grid's empty state — extracted because of the parent's cognitive
 * complexity, which exceeded Biome's threshold.
 *
 * `filtered` distinguishes the TWO causes: an environment where nothing is
 * deployed, and a search that returns nothing. Conflating them would say
 * "nothing here" to someone whose only fault was typing three letters.
 */
function GridEmpty({ filtered }: { filtered: boolean }) {
  return (
    <Empty className="min-h-48 flex-1">
      <EmptyHeader>
        <EmptyMedia>
          <IconStack>
            {filtered ? (
              <MagnifyingGlassIcon className="size-5" weight="duotone" />
            ) : (
              <StackIcon className="size-5" weight="duotone" />
            )}
          </IconStack>
        </EmptyMedia>
        <EmptyTitle>
          {filtered ? "Nothing matches" : "Nothing here yet"}
        </EmptyTitle>
        <EmptyDescription>
          {filtered
            ? "Try a different search or filter."
            : "Create a service to get started."}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

export function ResourceGrid({
  environmentId,
  groups,
  initialScope,
  projectId,
  role,
}: {
  environmentId: string;
  groups: ProjectGroup[];
  initialScope: Scope;
  projectId: string;
  role: RoleName | null;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // Move still needs the router: the environment selector counts and the
  // destination environment's loader come from route data, not this query.
  const router = useRouter();

  const [awaitingSettle, setAwaitingSettle] = useState(
    () => new Map<string, AwaitingEntry>()
  );

  const scopeQuery = useQuery({
    ...queries.environmentScope(projectId, environmentId),
    initialData: initialScope,
    refetchInterval: (q) =>
      shouldPoll(q.state.data, awaitingSettle) ? SCOPE_POLL_MS : false,
  });
  const scope = scopeQuery.data ?? initialScope;

  useEffect(() => {
    setAwaitingSettle((prev) => refineAwaiting(scope, prev));
  }, [scope]);

  const refreshScope = useCallback(
    () => cache.environmentScope(queryClient, projectId, environmentId),
    [queryClient, projectId, environmentId]
  );

  const markSettling = useCallback((targets: GridItem[]) => {
    setAwaitingSettle((prev) => {
      const next = new Map(prev);
      const now = Date.now();
      for (const item of targets) {
        next.set(itemKey(item), { since: now, status: item.status });
      }
      return next;
    });
  }, []);

  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [serverFilter, setServerFilter] = useState("all");
  const [sort, setSort] = useState<SortKey>("name");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [moveTarget, setMoveTarget] = useState<MoveTarget | null>(null);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

  const canDeploy = useCan(role, "service", "deploy");
  const canDelete = useCan(role, "service", "delete");
  const canMove = useCan(role, "service", "create");
  // DIFFERENT resource, and that's the point: `deployer` has both, but
  // nothing requires them to always go together — a future role could
  // operate applications without touching databases.
  const canOperateDatabase = useCan(role, "database", "operate");

  const items: GridItem[] = useMemo(
    () => [
      ...scope.services.map(
        (s): GridItem => ({
          domain: s.domain,
          id: s.id,
          kind: "service",
          lastError: s.lastError,
          name: s.name,
          serverName: s.serverName,
          status: s.status,
        })
      ),
      ...scope.stacks.map(
        (s): GridItem => ({
          domain: s.domain,
          id: s.id,
          kind: "stack",
          lastError: s.lastError,
          name: s.name,
          serverName: s.serverName,
          status: s.status,
        })
      ),
      ...scope.databases.map(
        (d): GridItem => ({
          domain: null,
          engine: d.engine,
          id: d.id,
          kind: "database",
          lastError: d.lastError,
          name: d.name,
          serverName: d.serverName,
          status: d.status,
        })
      ),
    ],
    [scope]
  );

  const servers = useMemo(
    () => [...new Set(items.map((i) => i.serverName))].sort(),
    [items]
  );

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = items.filter((item) => {
      if (typeFilter !== "all" && item.kind !== typeFilter) {
        return false;
      }
      if (serverFilter !== "all" && item.serverName !== serverFilter) {
        return false;
      }
      if (!q) {
        return true;
      }
      return (
        item.name.toLowerCase().includes(q) ||
        (item.domain?.toLowerCase().includes(q) ?? false)
      );
    });
    return [...list].sort((a, b) =>
      sort === "name"
        ? a.name.localeCompare(b.name)
        : a.status.localeCompare(b.status)
    );
  }, [items, search, typeFilter, serverFilter, sort]);

  const toggleSelected = useCallback((item: GridItem) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const key = itemKey(item);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);
  const clearSelection = useCallback(() => setSelected(new Set()), []);

  const selectedItems = useMemo(
    () => visible.filter((i) => selected.has(itemKey(i))),
    [visible, selected]
  );

  const openItem = useCallback(
    (item: GridItem) => {
      // The project AND the environment are part of the URL: a resource
      // only exists WITHIN an environment, and its address must say so.
      const scopeParams = {
        environmentId: scope.environmentId,
        projectId: scope.projectId,
      };
      if (item.kind === "service") {
        navigate({
          params: { ...scopeParams, serviceId: item.id },
          to: "/projects/$projectId/$environmentId/services/$serviceId",
        });
      } else if (item.kind === "stack") {
        navigate({
          params: { ...scopeParams, stackId: item.id },
          to: "/projects/$projectId/$environmentId/stacks/$stackId",
        });
      } else {
        navigate({
          params: { ...scopeParams, databaseId: item.id },
          to: "/projects/$projectId/$environmentId/databases/$databaseId",
        });
      }
    },
    [navigate, scope.environmentId, scope.projectId]
  );
  const requestMove = useCallback(
    (item: GridItem) =>
      setMoveTarget({
        environmentId: scope.environmentId,
        id: item.id,
        name: item.name,
      }),
    [scope.environmentId]
  );
  const closeMove = useCallback((open: boolean) => {
    if (!open) {
      setMoveTarget(null);
    }
  }, []);

  const handleMoved = useCallback(async () => {
    await refreshScope();
    await router.invalidate();
  }, [refreshScope, router]);

  const bulkDeploy = useMutation({
    mutationFn: async () => {
      const targets = selectedItems.filter((i) => hasDeploy(i.kind));
      for (const item of targets) {
        if (item.kind === "service") {
          // biome-ignore lint/performance/noAwaitInLoops: deliberately sequential deployments, no race between them
          await triggerDeploy({ data: { serviceId: item.id } });
        } else if (item.kind === "stack") {
          await triggerStackDeploy({ data: { stackId: item.id } });
        }
      }
      return targets.length;
    },
    onError: (e: Error) =>
      toast.add({
        description: errorMessage(e, "some deploys may not have started"),
        title: "Bulk deploy failed",
        type: "error",
      }),
    onSuccess: async (count) => {
      await refreshScope();
      clearSelection();
      toast.add({
        description: `${count} deploy${count === 1 ? "" : "s"} started.`,
        title: "Deploying",
        type: "success",
      });
    },
  });
  const handleBulkDeploy = useCallback(() => bulkDeploy.mutate(), [bulkDeploy]);

  const bulkLifecycle = useMutation({
    mutationFn: async (action: "start" | "stop") => {
      // DATABASES are included here, unlike deployment: they have a real
      // start/stop. Stacks remain excluded — see `hasLifecycle`.
      const targets = selectedItems.filter((i) => hasLifecycle(i.kind));
      for (const item of targets) {
        // biome-ignore lint/performance/noAwaitInLoops: deliberately sequential, one resource at a time
        await runLifecycleFor(item, action);
      }
      return targets;
    },
    onError: (e: Error) =>
      toast.add({
        description: errorMessage(e, "some items may not have changed"),
        title: "Bulk action failed",
        type: "error",
      }),
    onSuccess: async (targets, action) => {
      markSettling(targets);
      await refreshScope();
      clearSelection();
      toast.add({
        description: `${targets.length} item${targets.length === 1 ? "" : "s"} ${action === "start" ? "starting" : "stopping"}.`,
        title: action === "start" ? "Starting" : "Stopping",
        type: "success",
      });
    },
  });
  const handleBulkStart = useCallback(
    () => bulkLifecycle.mutate("start"),
    [bulkLifecycle]
  );
  const handleBulkStop = useCallback(
    () => bulkLifecycle.mutate("stop"),
    [bulkLifecycle]
  );

  const bulkDelete = useMutation({
    mutationFn: async () => {
      for (const item of selectedItems) {
        if (item.kind === "service") {
          // biome-ignore lint/performance/noAwaitInLoops: deliberately sequential deletions
          await deleteService({
            data: { confirmName: item.name, serviceId: item.id },
          });
        } else if (item.kind === "stack") {
          await deleteStack({
            data: { confirmName: item.name, stackId: item.id },
          });
        } else {
          await deleteDatabase({
            data: { confirmName: item.name, databaseId: item.id },
          });
        }
      }
      return selectedItems.length;
    },
    onError: (e: Error) =>
      toast.add({
        description: errorMessage(e, "some items may not have been removed"),
        title: "Bulk delete failed",
        type: "error",
      }),
    onSuccess: async (count) => {
      await refreshScope();
      clearSelection();
      setBulkDeleteOpen(false);
      toast.add({
        description: `${count} item${count === 1 ? "" : "s"} removed.`,
        title: "Deleted",
        type: "success",
      });
    },
  });
  const handleBulkDelete = useCallback(() => bulkDelete.mutate(), [bulkDelete]);
  const openBulkDelete = useCallback(() => setBulkDeleteOpen(true), []);

  const handleSearchChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => setSearch(e.target.value),
    []
  );
  const handleTypeFilterChange = useCallback(
    (next: unknown) => setTypeFilter(next as TypeFilter),
    []
  );
  const handleServerFilterChange = useCallback(
    (next: unknown) => setServerFilter(next as string),
    []
  );
  const handleSortChange = useCallback(
    (next: unknown) => setSort(next as SortKey),
    []
  );

  const hasSelection = selected.size > 0;
  const canBulkDeploy =
    canDeploy && selectedItems.some((i) => hasDeploy(i.kind));
  // The button only appears if the selection contains at least one
  // resource the user is allowed to operate — a service with
  // `service:deploy`, a database with `database:operate`.
  const canBulkOperate = selectedItems.some(
    (i) =>
      (i.kind === "service" && canDeploy) ||
      (i.kind === "database" && canOperateDatabase)
  );

  return (
    // `h-full` and not `flex-1`: the `AppShell` container does provide a
    // height, but it isn't itself a flex column — a `flex-1` placed here
    // would therefore have no parent to stretch against. As measured: the
    // empty state stayed at 192px in the middle of an otherwise empty
    // screen. Same fix as /containers.
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1">
          <MagnifyingGlassIcon className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Search"
            className="pl-9"
            onChange={handleSearchChange}
            placeholder="Search…"
            value={search}
          />
        </div>
        <Select
          items={{
            all: "All types",
            database: "Databases",
            service: "Services",
            stack: "Stacks",
          }}
          onValueChange={handleTypeFilterChange}
          value={typeFilter}
        >
          <SelectTrigger aria-label="Filter by type" className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="all">All types</SelectItem>
              <SelectItem value="service">Services</SelectItem>
              <SelectItem value="stack">Stacks</SelectItem>
              <SelectItem value="database">Databases</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
        {servers.length > 1 ? (
          <Select
            items={Object.fromEntries([
              ["all", "All servers"],
              ...servers.map((s) => [s, s]),
            ])}
            onValueChange={handleServerFilterChange}
            value={serverFilter}
          >
            <SelectTrigger aria-label="Filter by server" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="all">All servers</SelectItem>
                {servers.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        ) : null}
        <Select
          items={{ name: "Name", status: "Status" }}
          onValueChange={handleSortChange}
          value={sort}
        >
          <SelectTrigger aria-label="Sort by" className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="name">Name</SelectItem>
              <SelectItem value="status">Status</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>

      {hasSelection ? (
        <div className="flex flex-wrap items-center gap-2 rounded-2xl border bg-muted/40 px-3 py-2">
          <span className="text-sm">{selected.size} selected</span>
          <div className="ms-auto flex flex-wrap items-center gap-2">
            {canBulkDeploy ? (
              <Button
                disabled={bulkDeploy.isPending}
                onClick={handleBulkDeploy}
                size="sm"
                variant="outline"
              >
                {bulkDeploy.isPending ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <RocketLaunchIcon data-icon="inline-start" />
                )}
                Deploy
              </Button>
            ) : null}
            {canBulkOperate ? (
              <>
                <Button
                  disabled={bulkLifecycle.isPending}
                  onClick={handleBulkStart}
                  size="sm"
                  variant="outline"
                >
                  <PlayIcon data-icon="inline-start" weight="fill" />
                  Start
                </Button>
                <Button
                  disabled={bulkLifecycle.isPending}
                  onClick={handleBulkStop}
                  size="sm"
                  variant="outline"
                >
                  <StopIcon data-icon="inline-start" weight="fill" />
                  Stop
                </Button>
              </>
            ) : null}
            {canDelete ? (
              <Button onClick={openBulkDelete} size="sm" variant="destructive">
                <TrashIcon data-icon="inline-start" />
                Delete
              </Button>
            ) : null}
            <Button onClick={clearSelection} size="sm" variant="ghost">
              Clear
            </Button>
          </div>
        </div>
      ) : null}

      {visible.length === 0 ? (
        // `flex-1` and not a fixed height: an empty environment left a
        // 192px box floating at the top of an otherwise empty screen. The
        // empty state OCCUPIES the remaining space, like on /containers.
        <GridEmpty filtered={items.length > 0} />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((item) => (
            <ResourceGridCard
              canDelete={canDelete}
              canDeploy={canDeploy}
              canMove={canMove}
              canOperateDatabase={canOperateDatabase}
              item={item}
              key={itemKey(item)}
              onMove={item.kind === "service" ? requestMove : undefined}
              onOpen={openItem}
              onSettling={markSettling}
              onToggleSelect={toggleSelected}
              refreshScope={refreshScope}
              selected={selected.has(itemKey(item))}
            />
          ))}
        </div>
      )}

      {moveTarget ? (
        <MoveServiceDialog
          currentEnvironmentId={moveTarget.environmentId}
          groups={groups}
          onMoved={handleMoved}
          onOpenChange={closeMove}
          open
          serviceId={moveTarget.id}
          serviceName={moveTarget.name}
        />
      ) : null}

      <Dialog onOpenChange={setBulkDeleteOpen} open={bulkDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {selected.size} items?</DialogTitle>
            <DialogDescription>
              {selectedItems.map((i) => i.name).join(", ")}. Every deployment
              history, log and image tied to them is removed too.{" "}
              <strong>This cannot be undone.</strong>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline">Cancel</Button>} />
            <Button
              disabled={bulkDelete.isPending}
              onClick={handleBulkDelete}
              variant="destructive"
            >
              {bulkDelete.isPending ? (
                <Spinner data-icon="inline-start" />
              ) : null}
              Delete {selected.size} items
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

const KIND_ICON: Record<Kind, typeof CodeIcon> = {
  database: DatabaseIcon,
  service: CodeIcon,
  stack: StackIcon,
};

function ResourceGridCard({
  canDelete,
  canDeploy,
  canMove,
  canOperateDatabase,
  item,
  onMove,
  onOpen,
  onSettling,
  onToggleSelect,
  refreshScope,
  selected,
}: {
  canDelete: boolean;
  canDeploy: boolean;
  canMove: boolean;
  canOperateDatabase: boolean;
  item: GridItem;
  onMove: ((item: GridItem) => void) | undefined;
  onOpen: (item: GridItem) => void;
  onSettling: (items: GridItem[]) => void;
  onToggleSelect: (item: GridItem) => void;
  refreshScope: () => Promise<unknown>;
  selected: boolean;
}) {
  const [deleteOpen, setDeleteOpen] = useState(false);
  const status = serviceLabel(item.status);
  // A database shows the mark of ITS OWN engine; a service and a stack
  // keep the generic icon for their type. It's the only one of the three
  // whose nature varies, and that's what the mark conveys at a glance.
  const Icon = KIND_ICON[item.kind];
  const stopped = item.status === "stopped";
  // `created` = never deployed, `deleting` = teardown in progress: in both
  // cases there's no stable Swarm service to operate.
  const settled = item.status !== "created" && item.status !== "deleting";
  const mayOperate = item.kind === "database" ? canOperateDatabase : canDeploy;
  const lifecycleAvailable = hasLifecycle(item.kind) && mayOperate && settled;

  const handleOpen = useCallback(() => onOpen(item), [item, onOpen]);
  const handleToggleSelect = useCallback(
    () => onToggleSelect(item),
    [item, onToggleSelect]
  );
  const handleMove = useCallback(() => {
    onMove?.(item);
  }, [item, onMove]);
  const openDelete = useCallback(() => setDeleteOpen(true), []);

  return (
    <>
      {/* `relative` on the card, `after:absolute after:inset-0` on the
          title: the link covers the whole card WITHOUT nesting a button
          inside a clickable block — same pattern as `ItemContent` in
          `resource-row.tsx`. The checkbox and the menu trigger remain
          NORMAL buttons, just given `relative z-10` to stay above the
          stretched link in stacking order. */}
      <Card className="group relative transition-shadow hover:shadow-lg">
        <CardHeader>
          <div className="flex items-start justify-between gap-2">
            {item.engine ? (
              <DatabaseMark engine={item.engine} size="sm" />
            ) : (
              <IconTile size="sm" variant="frame">
                <Icon />
              </IconTile>
            )}
            {/* `z-10`: the title's stretched button places its `::after`
                over the WHOLE card, and comes AFTER this group in DOM
                order — without an explicit z-index, it would win the
                stacking order and these buttons would become unclickable.
                As measured: without `z-10`, `.click()` here reaches the
                title's button instead. */}
            <div className="relative z-10 flex items-center gap-1.5">
              <span
                aria-hidden
                className={`size-2 rounded-full ${dotClass(status.tone)}`}
              />
              <Checkbox
                aria-label={`Select ${item.name}`}
                checked={selected}
                className="opacity-0 transition-opacity group-hover:opacity-100 has-data-checked:opacity-100"
                onCheckedChange={handleToggleSelect}
              />
              <ResourceCardMenu
                canDelete={canDelete}
                canDeploy={canDeploy}
                canMove={Boolean(onMove) && canMove}
                item={item}
                lifecycleAvailable={lifecycleAvailable}
                onDelete={openDelete}
                onMove={onMove ? handleMove : undefined}
                onSettling={onSettling}
                refreshScope={refreshScope}
                stopped={stopped}
              />
            </div>
          </div>
          <CardTitle className="truncate">
            <button
              className="w-full truncate text-start after:absolute after:inset-0"
              onClick={handleOpen}
              type="button"
            >
              {item.name}
            </button>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <p className="truncate text-muted-foreground text-sm">
            {item.serverName}
            {item.domain ? ` · ${item.domain}` : ""}
          </p>
          <Badge className="w-fit" variant={badgeVariant(status.tone)}>
            {status.label}
          </Badge>
          {item.lastError ? (
            <p className="line-clamp-2 text-destructive text-xs" role="status">
              {item.lastError}
            </p>
          ) : null}
        </CardContent>
      </Card>

      <ResourceDeleteDialog
        item={item}
        onOpenChange={setDeleteOpen}
        open={deleteOpen}
        refreshScope={refreshScope}
      />
    </>
  );
}

function ResourceCardMenu({
  canDelete,
  canDeploy,
  canMove,
  item,
  lifecycleAvailable,
  onDelete,
  onMove,
  onSettling,
  refreshScope,
  stopped,
}: {
  canDelete: boolean;
  canDeploy: boolean;
  canMove: boolean;
  item: GridItem;
  lifecycleAvailable: boolean;
  onDelete: () => void;
  onMove: (() => void) | undefined;
  onSettling: (items: GridItem[]) => void;
  refreshScope: () => Promise<unknown>;
  stopped: boolean;
}) {
  const deploy = useMutation({
    mutationFn: async () => {
      if (item.kind === "service") {
        await triggerDeploy({ data: { serviceId: item.id } });
      } else {
        await triggerStackDeploy({ data: { stackId: item.id } });
      }
    },
    onError: (e: Error) =>
      toast.add({
        description: errorMessage(e, "the deploy did not start"),
        title: "Deploy failed",
        type: "error",
      }),
    onSuccess: async () => {
      await refreshScope();
    },
  });
  const handleDeploy = useCallback(() => deploy.mutate(), [deploy]);

  const lifecycle = useMutation({
    mutationFn: (action: LifecycleAction) => runLifecycleFor(item, action),
    onError: (e: Error) =>
      toast.add({
        description: errorMessage(e, "the action was refused"),
        title: "Action failed",
        type: "error",
      }),
    onSuccess: async () => {
      onSettling([item]);
      await refreshScope();
    },
  });
  const handleToggleRun = useCallback(
    () => lifecycle.mutate(stopped ? "start" : "stop"),
    [lifecycle, stopped]
  );
  const handleRestart = useCallback(
    () => lifecycle.mutate("restart"),
    [lifecycle]
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            aria-label={`Actions for ${item.name}`}
            className="size-6"
            size="icon"
            variant="ghost"
          >
            <DotsThreeIcon />
          </Button>
        }
      />
      <DropdownMenuContent align="end">
        {hasDeploy(item.kind) && canDeploy ? (
          <DropdownMenuItem disabled={deploy.isPending} onClick={handleDeploy}>
            <RocketLaunchIcon />
            Deploy
          </DropdownMenuItem>
        ) : null}
        {lifecycleAvailable ? (
          <DropdownMenuItem
            disabled={lifecycle.isPending}
            onClick={handleToggleRun}
          >
            {stopped ? <PlayIcon weight="fill" /> : <StopIcon weight="fill" />}
            {stopped ? "Start" : "Stop"}
          </DropdownMenuItem>
        ) : null}
        {lifecycleAvailable && !stopped ? (
          <DropdownMenuItem
            disabled={lifecycle.isPending}
            onClick={handleRestart}
          >
            <ArrowClockwiseIcon weight="fill" />
            Restart
          </DropdownMenuItem>
        ) : null}
        {onMove && canMove ? (
          <DropdownMenuItem onClick={onMove}>
            <DotsThreeIcon />
            Move to…
          </DropdownMenuItem>
        ) : null}
        {canDelete ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onDelete} variant="destructive">
              <TrashIcon />
              Delete
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ResourceDeleteDialog({
  item,
  onOpenChange,
  open,
  refreshScope,
}: {
  item: GridItem;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  refreshScope: () => Promise<unknown>;
}) {
  const remove = useMutation({
    mutationFn: (confirmName: string) => {
      if (item.kind === "service") {
        return deleteService({ data: { confirmName, serviceId: item.id } });
      }
      if (item.kind === "stack") {
        return deleteStack({ data: { confirmName, stackId: item.id } });
      }
      return deleteDatabase({ data: { confirmName, databaseId: item.id } });
    },
    onError: (e: Error) => {
      onOpenChange(false);
      toast.add({
        description: errorMessage(e, "deletion failed"),
        title: "Not deleted",
        type: "error",
      });
    },
    onSuccess: async () => {
      await refreshScope();
      onOpenChange(false);
    },
  });

  const handleConfirm = useCallback(
    (typed: string) => remove.mutate(typed),
    [remove]
  );

  return (
    <ConfirmNameDialog
      confirmLabel="Delete"
      description={
        <>
          Every deployment in its history, its logs and its images are removed
          too. <strong>This cannot be undone.</strong>
        </>
      }
      onConfirm={handleConfirm}
      onOpenChange={onOpenChange}
      open={open}
      pending={remove.isPending}
      resourceName={item.name}
      title={`Delete ${item.name}?`}
    />
  );
}
