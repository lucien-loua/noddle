"use client";

import { CornersOutIcon, GraphIcon } from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  MarkerType,
  Panel,
  ReactFlowProvider,
  useReactFlow,
  useStore,
} from "@xyflow/react";
import type { Edge, ReactFlowState } from "@xyflow/react";
import type { RefObject } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ConfirmNameDialog } from "@/components/confirm-name-dialog";
import {
  AttachDatabaseDialog,
  DEFAULT_ENV_VAR_KEY,
} from "@/components/features/database/attach-database-dialog";
import { IconStack } from "@/components/icon-stack";
import { useTerminalDialog } from "@/components/terminal-dialog";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Frame, FramePanel } from "@/components/ui/frame";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { FlowCanvas } from "@/components/xyflow/components/canvas";
import { edgeTypes } from "@/components/xyflow/components/edge";
import { getLayoutedElements } from "@/components/xyflow/lib/layout";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { cache } from "@/lib/cache";
import type { RoleName } from "@/lib/permissions";
import { queries } from "@/lib/queries";
import { useCan } from "@/lib/use-permission";
import type { Scope } from "@/server/dashboard";

import { RenameResourceDialog } from "./rename-resource-dialog";
import { TopologyDrawer } from "./topology-drawer";
import type { TopologyPanel } from "./topology-drawer";
import { buildTopology } from "./topology-graph";
import type { TopologyNode } from "./topology-graph";
import {
  TOPOLOGY_NODE_HEIGHT,
  TOPOLOGY_NODE_WIDTH,
  TopologyActionsProvider,
  topologyNodeTypes,
} from "./topology-node";
import type {
  LifecycleKind,
  TopologyAction,
  TopologyActions,
} from "./topology-node";
import { useTopologyLifecycle } from "./use-topology-lifecycle";

const FIT_VIEW = { maxZoom: 1, padding: 0.15 };
const FIT_VIEW_DURATION_MS = 200;

const DEFAULT_EDGE_OPTIONS = {
  markerEnd: {
    color: "var(--border)",
    height: 14,
    type: MarkerType.ArrowClosed,
    width: 14,
  },
};

const LAYOUT = {
  direction: "LR",
  nodeHeight: TOPOLOGY_NODE_HEIGHT,
  nodeWidth: TOPOLOGY_NODE_WIDTH,
} as const;

function collectHeights(state: ReactFlowState) {
  const heights = new Map<string, number>();
  for (const [id, node] of state.nodeLookup) {
    const height = node.measured?.height;
    if (height) {
      heights.set(id, height);
    }
  }
  return heights;
}

function sameHeights(
  a: ReadonlyMap<string, number>,
  b: ReadonlyMap<string, number>
) {
  return (
    a.size === b.size && [...b].every(([id, height]) => a.get(id) === height)
  );
}

function useMeasuredHeights(): ReadonlyMap<string, number> {
  return useStore(collectHeights, sameHeights);
}

function FitViewButton({ moved }: { moved: RefObject<boolean> }) {
  const { fitView } = useReactFlow();
  const reducedMotion = usePrefersReducedMotion();

  const handleClick = useCallback(() => {
    moved.current = false;
    fitView({
      ...FIT_VIEW,
      duration: reducedMotion ? 0 : FIT_VIEW_DURATION_MS,
    });
  }, [fitView, moved, reducedMotion]);

  return (
    <Panel position="top-right">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              aria-label="Fit to view"
              onClick={handleClick}
              size="icon-sm"
              variant="outline"
            >
              <CornersOutIcon weight="regular" />
            </Button>
          }
        />
        <TooltipContent>Fit to view</TooltipContent>
      </Tooltip>
    </Panel>
  );
}

function TopologyCanvas({
  edges,
  nodes,
}: {
  edges: Edge[];
  nodes: TopologyNode[];
}) {
  const moved = useRef(false);
  const heights = useMeasuredHeights();
  const { fitView } = useReactFlow();
  const size = useStore((state) => `${state.width}x${state.height}`);

  const graph = useMemo(() => {
    const sizeOf = (node: { id: string }) => {
      const height = heights.get(node.id);
      return height ? { height, width: TOPOLOGY_NODE_WIDTH } : undefined;
    };
    const laid = getLayoutedElements(nodes, edges, { ...LAYOUT, sizeOf });

    return {
      edges: laid.edges,
      nodes: laid.nodes.map((node) => {
        const height = heights.get(node.id);
        return height
          ? { ...node, measured: { height, width: TOPOLOGY_NODE_WIDTH } }
          : node;
      }),
    };
  }, [edges, heights, nodes]);

  useEffect(() => {
    if (graph.nodes.length === 0 || size === "0x0" || moved.current) {
      return;
    }
    fitView(FIT_VIEW);
  }, [fitView, graph.nodes, size]);

  const handleMoveStart = useCallback(
    (event: MouseEvent | TouchEvent | null) => {
      if (event) {
        moved.current = true;
      }
    },
    []
  );

  return (
    <FlowCanvas
      defaultEdgeOptions={DEFAULT_EDGE_OPTIONS}
      edges={graph.edges}
      edgeTypes={edgeTypes}
      fitViewOptions={FIT_VIEW}
      nodes={graph.nodes}
      nodesDraggable={false}
      nodeTypes={topologyNodeTypes}
      onMoveStart={handleMoveStart}
    >
      <FitViewButton moved={moved} />
    </FlowCanvas>
  );
}

function identityOf(scope: Scope, resource: LifecycleKind, id: string) {
  if (resource === "database") {
    return scope.databases.find((r) => r.id === id);
  }
  if (resource === "stack") {
    return scope.stacks.find((r) => r.id === id);
  }
  return scope.services.find((r) => r.id === id);
}

export function EnvironmentTopology({
  role,
  scope,
}: {
  role: RoleName | null;
  scope: Scope;
}) {
  const dependencies = useQuery(
    queries.environmentDependencies(scope.environmentId)
  );
  const canAttach = useCan(role, "database", "attach");
  const canShell = useCan(role, "container", "shell");
  const canRename = useCan(role, "service", "create");
  const { openTerminal, terminal } = useTerminalDialog();
  const [attachTo, setAttachTo] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{
    id: string;
    resource: LifecycleKind;
  } | null>(null);
  const [panel, setPanel] = useState<TopologyPanel | null>(null);
  const queryClient = useQueryClient();
  const {
    actions: resourceActions,
    lifecycle,
    remove,
    removing,
    rows,
    setRemoving,
  } = useTopologyLifecycle(scope, role);

  const rowById = useMemo(
    () => new Map(rows.map((row) => [row.id, row])),
    [rows]
  );

  const graph = useMemo(() => {
    const built = buildTopology(scope, dependencies.data ?? [], { canAttach });
    return {
      edges: built.edges,
      nodes: built.nodes.map((node) => {
        const row = rowById.get(node.id);
        if (!row) {
          return node;
        }
        return {
          ...node,
          data: {
            ...node.data,
            availableActions: resourceActions.actionsFor(row),
            resolvedStatus: resourceActions.statusOf(row),
          },
        };
      }),
    };
  }, [canAttach, dependencies.data, resourceActions, rowById, scope]);

  const handleAttached = useCallback(() => {
    cache.environmentDependencies(queryClient, scope.environmentId);
    setAttachTo(null);
  }, [queryClient, scope.environmentId]);

  const handleRemoveOpenChange = useCallback((open: boolean) => {
    if (!open) {
      setRemoving(null);
    }
  }, []);

  const handleRemoveConfirm = useCallback(
    (typed: string) => remove.mutate(typed),
    [remove]
  );

  const handleRenameOpenChange = useCallback((open: boolean) => {
    if (!open) {
      setRenaming(null);
    }
  }, []);

  const handleAttachOpenChange = useCallback((open: boolean) => {
    if (!open) {
      setAttachTo(null);
    }
  }, []);

  const handlePanelOpenChange = useCallback((open: boolean) => {
    if (!open) {
      setPanel(null);
    }
  }, []);

  const runAction = useCallback(
    (action: TopologyAction) => {
      if (action.kind === "attach") {
        setAttachTo(action.databaseId);
        return;
      }
      if (action.kind === "terminal") {
        openTerminal({
          id: action.id,
          kind: "container",
          target: action.resource,
          title: action.name,
        });
        return;
      }
      if (action.kind === "rename") {
        setRenaming({ id: action.id, resource: action.resource });
        return;
      }
      if (action.kind === "lifecycle") {
        const target = rowById.get(action.id);
        if (!target) {
          return;
        }
        if (action.action === "delete") {
          setRemoving(target);
        } else {
          lifecycle.mutate({ action: action.action, target });
        }
        return;
      }
      setPanel(action);
    },
    [lifecycle, openTerminal, rowById]
  );

  const actions = useMemo<TopologyActions>(
    () => ({
      canRename,
      canShell,
      run: runAction,
    }),
    [canRename, canShell, runAction]
  );

  const generation = useMemo(() => {
    if (panel?.kind !== "logs") {
      return "";
    }
    const candidates =
      panel.resource === "database" ? scope.databases : scope.services;
    const row = candidates.find((r) => r.id === panel.id);
    return row ? `${row.status}:${row.updatedAt}` : panel.id;
  }, [panel, scope.databases, scope.services]);

  const attaching = attachTo
    ? scope.databases.find((d) => d.id === attachTo)
    : undefined;
  const renamingRow = renaming
    ? identityOf(scope, renaming.resource, renaming.id)
    : undefined;

  if (dependencies.isPending) {
    return (
      <Frame className="flex min-h-0 flex-1 flex-col" variant="ghost">
        <FramePanel className="min-h-0 flex-1 overflow-hidden p-0" />
      </Frame>
    );
  }

  if (!graph.edges.some((edge) => edge.data?.ghost !== true)) {
    return (
      <Frame className="flex min-h-0 flex-1 flex-col" variant="ghost">
        <FramePanel className="flex min-h-0 flex-1 flex-col">
          <Empty className="min-h-0 flex-1 border-0">
            <EmptyHeader>
              <EmptyMedia>
                <IconStack>
                  <GraphIcon className="size-5" />
                </IconStack>
              </EmptyMedia>
              <EmptyTitle>Nothing is linked yet</EmptyTitle>
              <EmptyDescription>
                Attach a database to an application, or add a domain to reach
                one from the internet. Those are the links this view draws.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </FramePanel>
      </Frame>
    );
  }

  return (
    <Frame className="flex min-h-0 flex-1 flex-col" variant="ghost">
      <FramePanel className="min-h-0 flex-1 overflow-hidden p-0">
        <TopologyActionsProvider value={actions}>
          <ReactFlowProvider>
            <TopologyCanvas edges={graph.edges} nodes={graph.nodes} />
          </ReactFlowProvider>
        </TopologyActionsProvider>
      </FramePanel>

      <TopologyDrawer
        generation={generation}
        onOpenChange={handlePanelOpenChange}
        panel={panel}
        scope={scope}
      />
      {renamingRow && renaming ? (
        <RenameResourceDialog
          displayName={renamingRow.displayName ?? null}
          kind={renaming.resource}
          name={renamingRow.name}
          onOpenChange={handleRenameOpenChange}
          open
          resourceId={renamingRow.id}
        />
      ) : null}
      {terminal}

      <ConfirmNameDialog
        confirmLabel="Delete"
        description={
          <>
            Every deployment in its history, its logs and its images are removed
            too. <strong>This cannot be undone.</strong>
          </>
        }
        onConfirm={handleRemoveConfirm}
        onOpenChange={handleRemoveOpenChange}
        open={removing !== null}
        pending={remove.isPending}
        resourceName={removing?.name ?? ""}
        title={`Delete ${removing?.label ?? ""}?`}
      />

      {attaching ? (
        <AttachDatabaseDialog
          databaseId={attaching.id}
          defaultKey={DEFAULT_ENV_VAR_KEY[attaching.engine]}
          onAttached={handleAttached}
          onOpenChange={handleAttachOpenChange}
          open
          services={scope.services}
          showTrigger={false}
        />
      ) : null}
    </Frame>
  );
}
