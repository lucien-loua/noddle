import type { Connection, Edge } from "@xyflow/react";

export const FLOW_EDGE_TYPE = "edge";

export function isDuplicateConnection(
  edges: Edge[],
  connection: Pick<
    Connection,
    "source" | "target" | "sourceHandle" | "targetHandle"
  >
): boolean {
  return edges.some(
    (edge) =>
      edge.source === connection.source &&
      edge.target === connection.target &&
      edge.sourceHandle === connection.sourceHandle &&
      edge.targetHandle === connection.targetHandle
  );
}

export function createFlowEdge(
  connection: Connection,
  options: { id?: string; animated?: boolean } = {}
): Edge {
  const { source, target, sourceHandle, targetHandle } = connection;

  return {
    id:
      options.id ??
      `e-${source}-${target}-${sourceHandle ?? ""}-${targetHandle ?? ""}`,
    source: source ?? "",
    target: target ?? "",
    sourceHandle,
    targetHandle,
    type: FLOW_EDGE_TYPE,
    data: { animated: Boolean(options.animated) },
  };
}

export function setEdgesAnimated(edges: Edge[], animated: boolean): Edge[] {
  return edges.map((edge) => ({
    ...edge,
    data: { ...edge.data, animated },
  }));
}
