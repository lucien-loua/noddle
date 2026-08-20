"use client";

import { EdgeLabelRenderer, getSmoothStepPath } from "@xyflow/react";
import type { EdgeProps } from "@xyflow/react";
import { memo } from "react";

import { Badge } from "@/components/ui/badge";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";

const STROKE_WIDTH = 3;
const DASH = 8;
const GAP = 10;
const DASH_ARRAY = `${DASH} ${GAP}`;
/** The invisible hit area `BaseEdge` would have drawn for us. */
const INTERACTION_WIDTH = 20;

const EDGE_STYLE = { stroke: "var(--border)", strokeWidth: STROKE_WIDTH };
const EDGE_STYLE_SELECTED = {
  stroke: "var(--primary)",
  strokeWidth: STROKE_WIDTH,
};
const EDGE_STYLE_DASHED = { ...EDGE_STYLE, strokeDasharray: DASH_ARRAY };
const EDGE_STYLE_DASHED_SELECTED = {
  ...EDGE_STYLE_SELECTED,
  strokeDasharray: DASH_ARRAY,
};

/** `data.dashed` and `data.flowing` are all the edge reads: what the dash
 *  MEANS, and whether anything actually travels it, are the caller's. */
function styleFor(dashed: boolean, selected: boolean) {
  if (dashed) {
    return selected ? EDGE_STYLE_DASHED_SELECTED : EDGE_STYLE_DASHED;
  }
  return selected ? EDGE_STYLE_SELECTED : EDGE_STYLE;
}

/**
 * The path is written out rather than taken from `BaseEdge` for ONE reason:
 * the march is an SVG animation, and `<animate>` has to be a child of the
 * element it drives. `BaseEdge` takes no children — so its second, invisible
 * path is reproduced here, otherwise the edge loses its 20px hit area and
 * becomes a 3px line to click.
 */
const FlowEdge = memo(
  ({
    data,
    id,
    markerEnd,
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    selected,
  }: EdgeProps) => {
    const reducedMotion = usePrefersReducedMotion();
    const [edgePath, labelX, labelY] = getSmoothStepPath({
      sourceX,
      sourceY,
      sourcePosition,
      targetX,
      targetY,
      targetPosition,
      borderRadius: 16,
    });

    const dashed = data?.dashed === true;
    const flowing = dashed && data?.flowing === true && !reducedMotion;

    return (
      <>
        <path
          className="react-flow__edge-path"
          d={edgePath}
          fill="none"
          id={id}
          markerEnd={markerEnd}
          style={styleFor(dashed, selected === true)}
        >
          {flowing ? (
            // One whole dash PERIOD, so the loop has no seam.
            <animate
              attributeName="stroke-dashoffset"
              dur="0.7s"
              from="0"
              repeatCount="indefinite"
              to={-(DASH + GAP)}
            />
          ) : null}
        </path>
        <path
          className="react-flow__edge-interaction"
          d={edgePath}
          fill="none"
          strokeOpacity={0}
          strokeWidth={INTERACTION_WIDTH}
        />
        {data?.label ? (
          <EdgeLabelRenderer>
            <div
              className="pointer-events-none absolute"
              style={{
                transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              }}
            >
              <Badge className="bg-card tabular-nums" variant="outline">
                {String(data.label)}
              </Badge>
            </div>
          </EdgeLabelRenderer>
        ) : null}
      </>
    );
  }
);

FlowEdge.displayName = "FlowEdge";

export const edgeTypes = {
  edge: FlowEdge,
};

export { FlowEdge };
