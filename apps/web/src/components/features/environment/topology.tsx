"use client";

import { GraphIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useReactFlow, useStore } from "@xyflow/react";
import { useEffect, useMemo } from "react";

import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Frame, FramePanel } from "@/components/ui/frame";
import { FlowCanvas } from "@/components/xyflow/components/canvas";
import { edgeTypes } from "@/components/xyflow/components/edge";
import { getLayoutedElements } from "@/components/xyflow/lib/layout";
import { queries } from "@/lib/queries";
import type { Scope } from "@/server/dashboard";

import { buildTopology } from "./topology-graph";
import {
  TOPOLOGY_NODE_HEIGHT,
  TOPOLOGY_NODE_WIDTH,
  topologyNodeTypes,
} from "./topology-node";

/**
 * The environment, drawn: what the internet reaches, and what consumes what.
 *
 * Positions come from dagre on every render and are not stored. Dragging is
 * off for the same reason — a layout the user arranges and loses on reload
 * is worse than one that is simply always the same.
 */
const FIT_VIEW = { maxZoom: 1, padding: 0.15 };

/**
 * Re-frames the graph when the canvas changes size.
 *
 * `fitView` on `<ReactFlow>` runs ONCE, at mount. Resize the window and the
 * viewport stays framed on the box the graph used to have — measured at
 * 1100x560, where two of three nodes sat outside the frame. Reads the
 * dimensions React Flow itself measures, so it fires on the sidebar
 * collapsing too, not only on a window resize.
 */
function RefitOnResize() {
  const { fitView } = useReactFlow();
  const size = useStore((state) => `${state.width}x${state.height}`);

  useEffect(() => {
    if (size !== "0x0") {
      fitView(FIT_VIEW);
    }
  }, [fitView, size]);

  return null;
}

export function EnvironmentTopology({ scope }: { scope: Scope }) {
  const dependencies = useQuery(
    queries.environmentDependencies(scope.environmentId)
  );

  const graph = useMemo(() => {
    const built = buildTopology(scope, dependencies.data ?? []);
    return getLayoutedElements(built.nodes, built.edges, {
      direction: "LR",
      nodeHeight: TOPOLOGY_NODE_HEIGHT,
      nodeWidth: TOPOLOGY_NODE_WIDTH,
    });
  }, [dependencies.data, scope]);

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

  if (graph.edges.length === 0) {
    return (
      <Frame variant="ghost">
        <FramePanel>
          <Empty className="border-0">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <GraphIcon weight="regular" />
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
        <FlowCanvas
          edgeTypes={edgeTypes}
          // Without a ceiling, `fitView` on a three-node graph blows the
          // cards up to 1.7x and pushes the last one out of frame. 1 is the
          // size the node was designed at; it may zoom OUT freely.
          fitViewOptions={FIT_VIEW}
          edges={graph.edges}
          nodes={graph.nodes}
          nodesDraggable={false}
          nodeTypes={topologyNodeTypes}
        >
          <RefitOnResize />
        </FlowCanvas>
      </FramePanel>
    </Frame>
  );
}
