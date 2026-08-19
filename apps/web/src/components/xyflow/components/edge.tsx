"use client";

import { BaseEdge, getSmoothStepPath } from "@xyflow/react";
import type { EdgeProps } from "@xyflow/react";
import { memo } from "react";

const FlowEdge = memo(
  ({
    id,
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    selected,
  }: EdgeProps) => {
    const [edgePath] = getSmoothStepPath({
      sourceX,
      sourceY,
      sourcePosition,
      targetX,
      targetY,
      targetPosition,
      borderRadius: 16,
    });

    return (
      <BaseEdge
        fill="none"
        id={id}
        path={edgePath}
        style={{
          stroke: selected ? "var(--primary)" : "var(--border)",
          strokeWidth: 3,
        }}
      />
    );
  }
);

FlowEdge.displayName = "FlowEdge";

export const edgeTypes = {
  edge: FlowEdge,
};

export { FlowEdge };
