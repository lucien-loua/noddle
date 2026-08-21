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
import type { LifecycleTarget } from "./use-topology-lifecycle";
import { useTopologyLifecycle } from "./use-topology-lifecycle";

/**
 * The environment, drawn: what the internet reaches, and what consumes what.
 *
 * Positions come from dagre on every render and are not stored. Dragging is
 * off for the same reason — a layout the user arranges and loses on reload
 * is worse than one that is simply always the same.
 */
const FIT_VIEW = { maxZoom: 1, padding: 0.15 };

/** Direction is the whole point of the consumption edges, and a bare line
 *  states none: which end reads the other is unreadable without a head. */
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

/**
 * The heights React Flow measured, read straight from its lookup.
 *
 * NOT `useNodesInitialized`. That flag is recomputed only inside `setNodes`,
 * so with `nodes` passed as a controlled prop the ResizeObserver updates the
 * lookup without ever flipping it: measured, and reported uninitialised
 * forever. Its `includeHiddenNodes` branch is no better here — it tests
 * `nodeHasDimensions(userNode)`, and our user nodes carry no dimensions by
 * design. Compared by VALUE, so this settles after one pass instead of
 * feeding itself.
 */
function useMeasuredHeights(): ReadonlyMap<string, number> {
  return useStore(collectHeights, sameHeights);
}

function FitViewButton({ moved }: { moved: RefObject<boolean> }) {
  const { fitView } = useReactFlow();

  const handleClick = useCallback(() => {
    moved.current = false;
    fitView({ ...FIT_VIEW, duration: 200 });
  }, [fitView, moved]);

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

/**
 * Lays the graph out, then lays it out AGAIN on what React Flow measured.
 *
 * The first pass runs on an estimate, and one node is off it by design: the
 * internet card carries no footer, so its rank is centred on a box that does
 * not exist and it sits above the line its own edges leave from. Sits under a
 * `ReactFlowProvider` so the store hooks are readable HERE — measuring in a
 * child and handing the numbers back up would cost an extra render each pass.
 */
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

    // Hand the measurements BACK on the node objects. `adoptUserNodes`
    // rebuilds `measured` from the user node every time it receives a new
    // one, so without this each layout pass wipes what the ResizeObserver
    // just wrote, the two take turns, and the canvas renders blank.
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

  // `fitView` on <ReactFlow> runs ONCE, at mount. Resize the window and the
  // viewport stays framed on the box the graph used to have — measured at
  // 1100x560, where two of three nodes sat outside the frame. Reads the
  // dimensions React Flow itself measures, so it fires on the sidebar
  // collapsing too, not only on a window resize. Silent once the user has
  // panned or zoomed: re-framing a viewport somebody placed on purpose is
  // worse than leaving it there, and the button is how you get back.
  useEffect(() => {
    if (graph.nodes.length === 0 || size === "0x0" || moved.current) {
      return;
    }
    fitView(FIT_VIEW);
  }, [fitView, graph.nodes, size]);

  // React Flow passes `null` for its own moves, so only a real pan or zoom
  // silences the auto-fit above.
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
      // Without a ceiling, `fitView` on a three-node graph blows the cards up
      // to 1.7x and pushes the last one out of frame. 1 is the size the node
      // was designed at; it may zoom OUT freely.
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

/** The row behind a node, for the fields the canvas does not carry. */
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
  const canDeploy = useCan(role, "service", "deploy");
  const canDelete = useCan(role, "service", "delete");
  const canOperateDatabase = useCan(role, "database", "operate");
  const { openTerminal, terminal } = useTerminalDialog();
  const [attachTo, setAttachTo] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{
    id: string;
    resource: LifecycleKind;
  } | null>(null);
  const [panel, setPanel] = useState<TopologyPanel | null>(null);
  const queryClient = useQueryClient();
  const { lifecycle, pending, remove, removing, setRemoving } =
    useTopologyLifecycle(scope);

  const graph = useMemo(() => {
    const built = buildTopology(scope, dependencies.data ?? [], { canAttach });
    if (pending.size === 0) {
      return built;
    }
    // Overlaid HERE and not in `buildTopology`: the graph builder states what
    // the server says, and what the server says is exactly what is stale.
    return {
      edges: built.edges,
      nodes: built.nodes.map((node) => {
        const label = pending.get(node.id);
        return label
          ? { ...node, data: { ...node.data, pending: label } }
          : node;
      }),
    };
  }, [canAttach, dependencies.data, pending, scope]);

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
        // The identity is read from the scope, never from the node: the node
        // draws the DISPLAY name, and a delete confirmation checked against
        // that would refuse every renamed service.
        const row = identityOf(scope, action.resource, action.id);
        const target: LifecycleTarget = {
          id: action.id,
          label: action.name,
          name: row?.name ?? action.name,
          resource: action.resource,
          status: action.status,
        };
        if (action.action === "delete") {
          setRemoving(target);
        } else {
          lifecycle.mutate({ action: action.action, target });
        }
        return;
      }
      setPanel(action);
    },
    [lifecycle, openTerminal, scope]
  );

  const actions = useMemo<TopologyActions>(
    () => ({
      canDelete,
      canDeploy,
      canOperateDatabase,
      canRename,
      canShell,
      run: runAction,
    }),
    [canDelete, canDeploy, canOperateDatabase, canRename, canShell, runAction]
  );

  // Remounts the log stream when the container is replaced — start, restart
  // and redeploy all move the row's `status`/`updatedAt`, and without it the
  // drawer keeps tailing a container that no longer exists.
  const generation = useMemo(() => {
    if (panel?.kind !== "logs") {
      return "";
    }
    const rows =
      panel.resource === "database" ? scope.databases : scope.services;
    const row = rows.find((r) => r.id === panel.id);
    return row ? `${row.status}:${row.updatedAt}` : panel.id;
  }, [panel, scope.databases, scope.services]);

  const attaching = attachTo
    ? scope.databases.find((d) => d.id === attachTo)
    : undefined;
  // Looked up rather than carried in node data: the node draws the DISPLAY
  // name, and the dialog needs the identity underneath it too.
  const renamingRow = renaming
    ? identityOf(scope, renaming.resource, renaming.id)
    : undefined;

  // Held back until the edges are in. Laying out with the ingress edges
  // alone puts the databases in rank 0, and `fitView` runs ONCE, on mount:
  // the viewport would stay framed on a graph that no longer exists.
  if (dependencies.isPending) {
    return (
      <Frame className="flex min-h-0 flex-1 flex-col" variant="ghost">
        <FramePanel className="min-h-0 flex-1 overflow-hidden p-0" />
      </Frame>
    );
  }

  // Only REAL links: an attach slot is drawn on an empty graph too, and
  // counting its edge would replace the empty state with a canvas of
  // invitations.
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
      {/* React Flow MEASURES this box, so the chain above has to resolve to
          a real height — the tab root carries `h-full` for that reason. */}
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
