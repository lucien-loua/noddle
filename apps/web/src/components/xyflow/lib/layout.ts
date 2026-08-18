import { Graph, layout } from "@dagrejs/dagre";
import { Position } from "@xyflow/react";
import type { Edge, Node } from "@xyflow/react";

export type LayoutDirection = "TB" | "LR" | "BT" | "RL";

export interface LayoutOptions {
  direction?: LayoutDirection;
  nodeWidth?: number;
  nodeHeight?: number;
  nodesep?: number;
  ranksep?: number;
}

function isHorizontal(direction: LayoutDirection) {
  return direction === "LR" || direction === "RL";
}

/**
 * Positions nodes with dagre and aligns handle sides to the rank direction.
 * Edges are unchanged (xyflow draws them from the computed handle positions).
 */
export function getLayoutedElements<
  NodeType extends Node = Node,
  EdgeType extends Edge = Edge,
>(
  nodes: NodeType[],
  edges: EdgeType[],
  options: LayoutOptions = {}
): { nodes: NodeType[]; edges: EdgeType[] } {
  const {
    direction = "LR",
    nodeWidth = 256,
    nodeHeight = 160,
    nodesep = 80,
    ranksep = 120,
  } = options;

  const graph = new Graph();
  graph.setDefaultEdgeLabel(() => ({}));
  graph.setGraph({ rankdir: direction, nodesep, ranksep });

  for (const node of nodes) {
    const width = node.measured?.width ?? node.width ?? nodeWidth;
    const height = node.measured?.height ?? node.height ?? nodeHeight;
    graph.setNode(node.id, { width, height });
  }

  for (const edge of edges) {
    graph.setEdge(edge.source, edge.target);
  }

  layout(graph);

  const sourcePosition = isHorizontal(direction)
    ? Position.Right
    : Position.Bottom;
  const targetPosition = isHorizontal(direction) ? Position.Left : Position.Top;

  const layoutedNodes = nodes.map((node) => {
    const laidOut = graph.node(node.id);
    const width = laidOut.width ?? nodeWidth;
    const height = laidOut.height ?? nodeHeight;

    return {
      ...node,
      sourcePosition,
      targetPosition,
      position: {
        x: laidOut.x - width / 2,
        y: laidOut.y - height / 2,
      },
    };
  });

  return { nodes: layoutedNodes, edges };
}
