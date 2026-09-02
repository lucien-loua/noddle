import { DATABASE_ENGINE_LABEL } from "@noddle/database-spec";
import type { DatabaseEngine } from "@noddle/database-spec";
import {
  ArrowClockwiseIcon,
  ArrowSquareOutIcon,
  CodeIcon,
  DatabaseIcon,
  DotsThreeIcon,
  GlobeIcon,
  HardDrivesIcon,
  MagnifyingGlassIcon,
  PlayIcon,
  RocketLaunchIcon,
  StackIcon,
  TagIcon,
  StopIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouter } from "@tanstack/react-router";
import type { ChangeEvent, MouseEvent, ReactNode } from "react";
import { useCallback, useMemo, useRef, useState } from "react";

import { ConfirmNameDialog } from "@/components/confirm-name-dialog";
import { DatabaseMark } from "@/components/features/database/database-mark";
import { MoveServiceDialog } from "@/components/features/services/move-dialog";
import {
  DockerIcon,
  GithubIcon,
  GitIcon,
  GitlabIcon,
} from "@/components/features/services/provider-icons";
import { IconStack } from "@/components/icon-stack";
import { Button } from "@/components/ui/button";
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
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Frame,
  FrameFooter,
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
import { Spinner } from "@/components/ui/spinner";
import { StatusIndicator } from "@/components/ui/status";
import { toast } from "@/components/ui/toast";
import { cache } from "@/lib/cache";
import { errorMessage } from "@/lib/format";
import type { RoleName } from "@/lib/permissions";
import { queries } from "@/lib/queries";
import type {
  Action,
  ResourceActions,
} from "@/lib/resource-actions/use-resource-actions";
import { useResourceActions } from "@/lib/resource-actions/use-resource-actions";
import { scopeRows } from "@/lib/scope-rows";
import type { ResourceKind, ResourceRow } from "@/lib/scope-rows";
import { useCan } from "@/lib/use-permission";
import { cn } from "@/lib/utils";
import type { ProjectGroup, Scope } from "@/server/dashboard";

import { RenameResourceDialog } from "./rename-resource-dialog";

type Source = "compose" | "docker_image" | "git" | "github" | "gitlab";

const SOURCE: Record<
  Source,
  { icon: (props: { className?: string }) => React.JSX.Element; label: string }
> = {
  compose: { icon: DockerIcon, label: "Compose" },
  docker_image: { icon: DockerIcon, label: "Image" },
  git: { icon: GitIcon, label: "Git" },
  github: { icon: GithubIcon, label: "GitHub" },
  gitlab: { icon: GitlabIcon, label: "GitLab" },
};
type SortKey = "name" | "status";
type TypeFilter = "all" | ResourceKind;
type LifecycleAction = "restart" | "start" | "stop";

interface GridExtra {
  displayName: string | null;
  domain: string | null;
  domainUrl: string | null;
  engine?: DatabaseEngine;
  lastError: string | null;
  source: Source | null;
}

interface GridItem extends ResourceRow, GridExtra {}

interface MoveTarget {
  environmentId: string;
  id: string;
  name: string;
}

interface GridPermissions {
  move: boolean;
  rename: boolean;
}

function ResourceAddress({ item }: { item: GridItem }) {
  if (item.engine) {
    return (
      <span className="truncate">{DATABASE_ENGINE_LABEL[item.engine]}</span>
    );
  }
  if (!item.domain) {
    return <span className="text-muted-foreground">No domain</span>;
  }
  if (!item.domainUrl) {
    return <span className="truncate">{item.domain}</span>;
  }
  return (
    <a
      className="relative z-20 inline-flex min-w-0 items-center gap-1 hover:underline"
      href={item.domainUrl}
      rel="noreferrer noopener"
      target="_blank"
    >
      <span className="truncate">{item.domain}</span>
      <ArrowSquareOutIcon className="size-3.5 shrink-0" weight="regular" />
    </a>
  );
}

function itemKey(item: { id: string; kind: ResourceKind }): string {
  return `${item.kind}:${item.id}`;
}

function GridEmpty({
  createAction,
  filtered,
}: {
  createAction?: ReactNode;
  filtered: boolean;
}) {
  return (
    <Frame className="flex min-h-0 flex-1 flex-col" variant="ghost">
      <FramePanel className="flex min-h-0 flex-1 flex-col">
        <Empty className="min-h-0 flex-1 border-0">
          <EmptyHeader>
            <EmptyMedia>
              <IconStack>
                {filtered ? (
                  <MagnifyingGlassIcon className="size-5" />
                ) : (
                  <StackIcon className="size-5" />
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
          {createAction ? <EmptyContent>{createAction}</EmptyContent> : null}
        </Empty>
      </FramePanel>
    </Frame>
  );
}

interface GridProps {
  createAction?: ReactNode;
  environmentId: string;
  groups: ProjectGroup[];
  initialScope: Scope;
  projectId: string;
  role: RoleName | null;
}

function extrasFor(scope: Scope): Map<string, GridExtra> {
  const map = new Map<string, GridExtra>();
  for (const s of scope.services) {
    const [first] = s.domains;
    map.set(itemKey({ id: s.id, kind: "service" }), {
      displayName: s.displayName,
      domain: first?.host ?? null,
      domainUrl: first
        ? `${first.https ? "https" : "http"}://${first.host}`
        : null,
      lastError: s.lastError,
      source: s.sourceType,
    });
  }
  for (const s of scope.stacks) {
    map.set(itemKey({ id: s.id, kind: "stack" }), {
      displayName: s.displayName,
      domain: s.domain,
      domainUrl: null,
      lastError: s.lastError,
      source: "git",
    });
  }
  for (const d of scope.databases) {
    map.set(itemKey({ id: d.id, kind: "database" }), {
      displayName: d.displayName,
      domain: null,
      domainUrl: null,
      engine: d.engine,
      lastError: d.lastError,
      source: null,
    });
  }
  return map;
}

function useResourceGridState({
  environmentId,
  initialScope,
  projectId,
  role,
}: GridProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const router = useRouter();

  const pollIntervalRef = useRef<false | number>(false);
  const scopeQuery = useQuery({
    ...queries.environmentScope(projectId, environmentId),
    initialData: initialScope,
    refetchInterval: () => pollIntervalRef.current,
  });
  const scope = scopeQuery.data ?? initialScope;

  const rows = useMemo(() => scopeRows(scope), [scope]);
  const actions = useResourceActions(rows, role);
  pollIntervalRef.current = actions.pollInterval;

  const refreshScope = useCallback(
    () => cache.environmentScope(queryClient, projectId, environmentId),
    [queryClient, projectId, environmentId]
  );

  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [serverFilter, setServerFilter] = useState("all");
  const [sort, setSort] = useState<SortKey>("name");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [moveTarget, setMoveTarget] = useState<MoveTarget | null>(null);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [renaming, setRenaming] = useState<GridItem | null>(null);

  const closeRename = useCallback((open: boolean) => {
    if (!open) {
      setRenaming(null);
    }
  }, []);

  const canMove = useCan(role, "service", "create");
  const can: GridPermissions = { move: canMove, rename: canMove };

  const extrasByKey = useMemo(() => extrasFor(scope), [scope]);

  const items: GridItem[] = useMemo(
    () =>
      rows.map((row) => ({
        ...row,
        ...(extrasByKey.get(itemKey(row)) as GridExtra),
      })),
    [rows, extrasByKey]
  );

  const servers = useMemo(
    () => [...new Set(items.map((i) => i.serverName))].toSorted(),
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
        item.label.toLowerCase().includes(q) ||
        (item.domain?.toLowerCase().includes(q) ?? false)
      );
    });
    return [...list].toSorted((a, b) =>
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
      const targets = selectedItems.filter((i) =>
        actions.actionsFor(i).has("deploy")
      );
      for (const item of targets) {
        await actions.run(item, "deploy");
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
      const targets = selectedItems.filter((i) =>
        actions.actionsFor(i).has(action)
      );
      for (const item of targets) {
        await actions.run(item, action);
      }
      return { action, count: targets.length };
    },
    onError: (e: Error) =>
      toast.add({
        description: errorMessage(e, "some items may not have changed"),
        title: "Bulk action failed",
        type: "error",
      }),
    onSuccess: async ({ action, count }) => {
      await refreshScope();
      clearSelection();
      toast.add({
        description: `${count} item${count === 1 ? "" : "s"} ${action === "start" ? "starting" : "stopping"}.`,
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
        await actions.run(item, "delete", { confirmName: item.name });
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
  const canBulkDeploy = selectedItems.some((i) =>
    actions.actionsFor(i).has("deploy")
  );
  const canBulkOperate = selectedItems.some((i) => {
    const set = actions.actionsFor(i);
    return set.has("start") || set.has("stop");
  });
  const canBulkDelete = selectedItems.some((i) =>
    actions.actionsFor(i).has("delete")
  );

  return {
    actions,
    bulkDelete,
    bulkDeleteOpen,
    closeRename,
    renaming,
    setRenaming,
    bulkDeploy,
    bulkLifecycle,
    can,
    canBulkDelete,
    canBulkDeploy,
    canBulkOperate,
    clearSelection,
    closeMove,
    handleBulkDelete,
    handleBulkDeploy,
    handleBulkStart,
    handleBulkStop,
    handleMoved,
    handleSearchChange,
    handleServerFilterChange,
    handleSortChange,
    handleTypeFilterChange,
    hasSelection,
    items,
    moveTarget,
    openBulkDelete,
    openItem,
    refreshScope,
    requestMove,
    search,
    selected,
    selectedItems,
    serverFilter,
    servers,
    setBulkDeleteOpen,
    sort,
    toggleSelected,
    typeFilter,
    visible,
  };
}

export function ResourceGrid(props: GridProps) {
  const { createAction, groups } = props;
  const {
    actions,
    bulkDelete,
    bulkDeleteOpen,
    closeRename,
    renaming,
    setRenaming,
    bulkDeploy,
    bulkLifecycle,
    can,
    canBulkDelete,
    canBulkDeploy,
    canBulkOperate,
    clearSelection,
    closeMove,
    handleBulkDelete,
    handleBulkDeploy,
    handleBulkStart,
    handleBulkStop,
    handleMoved,
    handleSearchChange,
    handleServerFilterChange,
    handleSortChange,
    handleTypeFilterChange,
    hasSelection,
    items,
    moveTarget,
    openBulkDelete,
    openItem,
    refreshScope,
    requestMove,
    search,
    selected,
    selectedItems,
    serverFilter,
    servers,
    setBulkDeleteOpen,
    sort,
    toggleSelected,
    typeFilter,
    visible,
  } = useResourceGridState(props);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <InputGroup className="min-w-48 flex-1">
          <InputGroupAddon>
            <MagnifyingGlassIcon />
          </InputGroupAddon>
          <InputGroupInput
            aria-label="Search"
            onChange={handleSearchChange}
            placeholder="Search…"
            value={search}
          />
        </InputGroup>
        <Select
          items={{
            all: "All types",
            database: "Databases",
            service: "Applications",
            stack: "Compose",
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
              <SelectItem value="service">Applications</SelectItem>
              <SelectItem value="stack">Compose</SelectItem>
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
                  <RocketLaunchIcon data-icon="inline-start" weight="regular" />
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
            {canBulkDelete ? (
              <Button onClick={openBulkDelete} size="sm" variant="destructive">
                <TrashIcon data-icon="inline-start" weight="regular" />
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
        <GridEmpty
          createAction={items.length === 0 ? createAction : undefined}
          filtered={items.length > 0}
        />
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,clamp(16rem,28vw,22rem)),1fr))] gap-3">
          {visible.map((item) => (
            <ResourceGridCard
              actions={actions}
              can={can}
              item={item}
              key={itemKey(item)}
              onMove={item.kind === "service" ? requestMove : undefined}
              onOpen={openItem}
              onRename={setRenaming}
              onToggleSelect={toggleSelected}
              refreshScope={refreshScope}
              selected={selected.has(itemKey(item))}
              selectionMode={hasSelection}
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

      {renaming ? (
        <RenameResourceDialog
          displayName={renaming.displayName ?? null}
          kind={renaming.kind}
          name={renaming.name}
          onOpenChange={closeRename}
          open
          resourceId={renaming.id}
        />
      ) : null}

      <Dialog onOpenChange={setBulkDeleteOpen} open={bulkDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Delete {selected.size}{" "}
              {selected.size === 1 ? "resource" : "resources"}?
            </DialogTitle>
            <DialogDescription>
              {selectedItems.map((i) => i.label).join(", ")}. Every deployment
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
              Delete {selected.size}{" "}
              {selected.size === 1 ? "resource" : "resources"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

const KIND_ICON: Record<ResourceKind, typeof CodeIcon> = {
  database: DatabaseIcon,
  service: CodeIcon,
  stack: StackIcon,
};

function ResourceGridCard({
  actions,
  can,
  item,
  onMove,
  onOpen,
  onRename,
  onToggleSelect,
  refreshScope,
  selected,
  selectionMode,
}: {
  actions: ResourceActions;
  can: GridPermissions;
  item: GridItem;
  onMove: ((item: GridItem) => void) | undefined;
  onOpen: (item: GridItem) => void;
  onRename: (item: GridItem) => void;
  onToggleSelect: (item: GridItem) => void;
  refreshScope: () => Promise<unknown>;
  selected: boolean;
  selectionMode: boolean;
}) {
  const [deleteOpen, setDeleteOpen] = useState(false);
  const status = actions.statusOf(item);
  const Icon = KIND_ICON[item.kind];
  const source = item.source ? SOURCE[item.source] : null;
  const stopped = item.status === "stopped";
  const available = actions.actionsFor(item);
  const inFlight = status.tone === "busy";

  const handleSurfaceClick = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      if (selectionMode || event.metaKey || event.ctrlKey) {
        onToggleSelect(item);
        return;
      }
      onOpen(item);
    },
    [item, onOpen, onToggleSelect, selectionMode]
  );
  const handleRename = useCallback(() => onRename(item), [item, onRename]);
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
      <Frame
        className={cn(
          "group transition-shadow hover:shadow-lg",
          selected && "ring-2 ring-primary"
        )}
      >
        <button
          aria-hidden
          className="absolute inset-0 z-10 cursor-pointer"
          onClick={handleSurfaceClick}
          tabIndex={-1}
          type="button"
        />
        <FrameHeader>
          <div className="flex items-center gap-2">
            {item.engine ? (
              <DatabaseMark engine={item.engine} size="sm" />
            ) : (
              <Icon className="size-5 shrink-0 text-muted-foreground" />
            )}
            <FrameTitle className="relative z-20 min-w-0 flex-1 truncate">
              <button
                className="w-full cursor-pointer truncate text-start"
                onClick={handleSurfaceClick}
                type="button"
              >
                {item.label}
              </button>
            </FrameTitle>
            <div className="relative z-20 flex items-center gap-1">
              <Checkbox
                aria-label={`Select ${item.label}`}
                checked={selected}
                onCheckedChange={handleToggleSelect}
              />
              <ResourceCardMenu
                actions={actions}
                available={available}
                busy={inFlight}
                can={can}
                item={item}
                onDelete={openDelete}
                onMove={onMove ? handleMove : undefined}
                onRename={handleRename}
                refreshScope={refreshScope}
                stopped={stopped}
              />
            </div>
          </div>
        </FrameHeader>
        <FramePanel className="flex flex-col gap-3">
          <div aria-live="polite" className="flex items-center gap-2 text-sm">
            {inFlight ? (
              <Spinner className="size-2.5 shrink-0" />
            ) : (
              <StatusIndicator className="size-2.5" tone={status.tone} />
            )}
            <span className="truncate">{status.label}</span>
          </div>
          <div className="flex items-center gap-1.5 text-sm">
            {item.engine ? (
              <DatabaseIcon className="size-4 shrink-0 text-muted-foreground" />
            ) : (
              <GlobeIcon className="size-4 shrink-0 text-muted-foreground" />
            )}
            <ResourceAddress item={item} />
          </div>
          {item.lastError ? (
            <output className="block line-clamp-2 text-destructive text-xs">
              {item.lastError}
            </output>
          ) : null}
        </FramePanel>
        <FrameFooter>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-xs">
            <span className="flex min-w-0 items-center gap-1.5">
              <HardDrivesIcon aria-hidden className="size-3.5 shrink-0" />
              <span className="truncate">{item.serverName}</span>
            </span>
            {source ? (
              <span className="flex items-center gap-1.5">
                <source.icon className="size-3.5 shrink-0" />
                {source.label}
              </span>
            ) : null}
          </div>
        </FrameFooter>
      </Frame>

      <ResourceDeleteDialog
        actions={actions}
        item={item}
        onOpenChange={setDeleteOpen}
        open={deleteOpen}
        refreshScope={refreshScope}
      />
    </>
  );
}

function ResourceCardMenu({
  actions,
  available,
  busy,
  can,
  item,
  onDelete,
  onMove,
  onRename,
  refreshScope,
  stopped,
}: {
  actions: ResourceActions;
  available: Set<Action>;
  busy: boolean;
  can: GridPermissions;
  item: GridItem;
  onDelete: () => void;
  onRename: () => void;
  onMove: (() => void) | undefined;
  refreshScope: () => Promise<unknown>;
  stopped: boolean;
}) {
  const deploy = useMutation({
    mutationFn: () => actions.run(item, "deploy"),
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
    mutationFn: (action: LifecycleAction) => actions.run(item, action),
    onError: (e: Error) =>
      toast.add({
        description: errorMessage(e, "the action was refused"),
        title: "Action failed",
        type: "error",
      }),
    onSuccess: async () => {
      await refreshScope();
    },
  });
  const lifecycleBusy = lifecycle.isPending || busy;
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
            aria-label={`Actions for ${item.label}`}
            size="icon-xs"
            variant="ghost"
          >
            <DotsThreeIcon weight="regular" />
          </Button>
        }
      />
      <DropdownMenuContent align="end">
        {available.has("deploy") ? (
          <DropdownMenuItem disabled={deploy.isPending} onClick={handleDeploy}>
            <RocketLaunchIcon />
            Deploy
          </DropdownMenuItem>
        ) : null}
        {available.has(stopped ? "start" : "stop") ? (
          <DropdownMenuItem disabled={lifecycleBusy} onClick={handleToggleRun}>
            {stopped ? <PlayIcon weight="fill" /> : <StopIcon weight="fill" />}
            {stopped ? "Start" : "Stop"}
          </DropdownMenuItem>
        ) : null}
        {available.has("restart") ? (
          <DropdownMenuItem disabled={lifecycleBusy} onClick={handleRestart}>
            <ArrowClockwiseIcon weight="fill" />
            Restart
          </DropdownMenuItem>
        ) : null}
        {can.rename ? (
          <DropdownMenuItem onClick={onRename}>
            <TagIcon />
            Rename
          </DropdownMenuItem>
        ) : null}
        {onMove && can.move ? (
          <DropdownMenuItem onClick={onMove}>
            <DotsThreeIcon weight="regular" />
            Move to…
          </DropdownMenuItem>
        ) : null}
        {available.has("delete") ? (
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
  actions,
  item,
  onOpenChange,
  open,
  refreshScope,
}: {
  actions: ResourceActions;
  item: GridItem;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  refreshScope: () => Promise<unknown>;
}) {
  const remove = useMutation({
    mutationFn: (confirmName: string) =>
      actions.run(item, "delete", { confirmName }),
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
      title={`Delete ${item.label}?`}
    />
  );
}
