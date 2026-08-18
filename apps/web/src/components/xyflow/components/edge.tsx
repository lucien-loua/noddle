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
    data,
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

    const isAnimated = Boolean(data?.animated);
    const gradientId = `flow-gradient-${id}`;

    return (
      <>
        <BaseEdge
          fill="none"
          id={id}
          path={edgePath}
          style={{
            stroke: selected ? "var(--primary)" : "var(--border)",
            strokeWidth: 3,
            transition: "stroke 0.2s ease",
          }}
        />

        {isAnimated && (
          <>
            <defs>
              <linearGradient id={gradientId} x1="0%" x2="100%" y1="0%" y2="0%">
                <stop offset="0%" stopColor="var(--primary)" stopOpacity="0" />
                <stop offset="50%" stopColor="var(--primary)" stopOpacity="1" />
                <stop
                  offset="100%"
                  stopColor="var(--primary)"
                  stopOpacity="0"
                />
              </linearGradient>
            </defs>
            <circle fill="var(--primary)" r="5">
              <animateMotion
                dur="1.5s"
                path={edgePath}
                repeatCount="indefinite"
              />
            </circle>
          </>
        )}
      </>
    );
  }
);

FlowEdge.displayName = "FlowEdge";

export const edgeTypes = {
  edge: FlowEdge,
};

export { FlowEdge };
