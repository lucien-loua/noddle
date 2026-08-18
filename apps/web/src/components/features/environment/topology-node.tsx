"use client";

import { DATABASE_ENGINE_LABEL } from "@noddle/database-spec";
import {
  CodeIcon,
  DatabaseIcon,
  GlobeIcon,
  HardDrivesIcon,
  StackIcon,
} from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { Position } from "@xyflow/react";
import type { Node as FlowNodeType, NodeProps } from "@xyflow/react";

import { DatabaseMark } from "@/components/features/database/database-mark";
import {
  Frame,
  FrameFooter,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@/components/ui/frame";
import { Handle } from "@/components/xyflow/components/handle";
import { dotClass, serviceLabel } from "@/lib/format";

import type { TopologyNodeData, TopologyTarget } from "./topology-graph";

/** Measured on the rendered node: dagre spaces ranks from these, and a wrong
 *  height opens gaps the graph does not need. */
export const TOPOLOGY_NODE_WIDTH = 288;
export const TOPOLOGY_NODE_HEIGHT = 112;

const LINK_CLASS =
  "w-full truncate text-start outline-none after:absolute after:inset-0 hover:underline focus-visible:underline";

/** Three branches rather than a computed path: the router types `to` and its
 *  params together, and a template string forfeits both. */
function TargetLink({
  label,
  target,
}: {
  label: string;
  target: TopologyTarget;
}) {
  const { environmentId, id, projectId } = target;
  if (target.resource === "databases") {
    return (
      <Link
        className={LINK_CLASS}
        params={{ databaseId: id, environmentId, projectId }}
        to="/projects/$projectId/$environmentId/databases/$databaseId"
      >
        {label}
      </Link>
    );
  }
  if (target.resource === "stacks") {
    return (
      <Link
        className={LINK_CLASS}
        params={{ environmentId, projectId, stackId: id }}
        to="/projects/$projectId/$environmentId/stacks/$stackId"
      >
        {label}
      </Link>
    );
  }
  return (
    <Link
      className={LINK_CLASS}
      params={{ environmentId, projectId, serviceId: id }}
      to="/projects/$projectId/$environmentId/services/$serviceId"
    >
      {label}
    </Link>
  );
}

function Mark({ data }: { data: TopologyNodeData }) {
  if (data.kind === "database" && data.engine) {
    return <DatabaseMark engine={data.engine} size="sm" />;
  }
  // `size-5` against the mark's `size-6`: a solid glyph reads heavier than a
  // brand logo inside the same box. Same pairing as the grid card.
  if (data.kind === "internet") {
    return <GlobeIcon className="size-5 shrink-0 text-muted-foreground" />;
  }
  const Icon = data.kind === "stack" ? StackIcon : CodeIcon;
  return <Icon className="size-5 shrink-0 text-muted-foreground" />;
}

/**
 * One resource on the canvas, in the grid card's own grammar: the header says
 * WHAT this is, the panel says HOW IT IS DOING, the footer says WHERE IT
 * LIVES. Written on `Frame` rather than the flow template's `Node`, so a
 * resource looks the same whichever screen draws it.
 *
 * The internet node keeps the header alone: it is the boundary, not a
 * resource, and it has neither a status nor a server to state.
 */
export function TopologyNode({
  data,
}: NodeProps<FlowNodeType<TopologyNodeData>>) {
  const status = data.status ? serviceLabel(data.status) : null;
  const engine =
    data.kind === "database" && data.engine
      ? DATABASE_ENGINE_LABEL[data.engine]
      : null;

  return (
    <Frame style={{ width: TOPOLOGY_NODE_WIDTH, backdropFilter: "blur(10px)" }}>
      {data.hasTarget ? (
        <Handle position={Position.Left} type="target" />
      ) : null}

      <FrameHeader>
        <div className="flex items-center gap-2">
          <Mark data={data} />
          <FrameTitle className="min-w-0 flex-1 truncate">
            {data.target ? (
              <TargetLink label={data.label} target={data.target} />
            ) : (
              data.label
            )}
          </FrameTitle>
        </div>
      </FrameHeader>

      {status ? (
        <FramePanel className="flex flex-col gap-3">
          {/* A dot, not a badge: on a canvas you scan shapes, and a disc in a
              fixed position reads without being read. The word stays beside
              it — colour is never the only channel. */}
          <div className="flex items-center gap-2 text-sm">
            <span
              aria-hidden
              className={`size-2.5 shrink-0 rounded-full ${dotClass(status.tone)}`}
            />
            <span className="truncate">{status.label}</span>
          </div>
          <div className="flex items-center gap-1.5 text-sm">
            {engine ? (
              <DatabaseIcon className="size-4 shrink-0 text-muted-foreground" />
            ) : (
              <GlobeIcon className="size-4 shrink-0 text-muted-foreground" />
            )}
            <span className="truncate text-muted-foreground">
              {engine ?? data.address ?? "No domain"}
            </span>
          </div>
        </FramePanel>
      ) : null}

      {data.serverName ? (
        <FrameFooter>
          <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
            <HardDrivesIcon aria-hidden className="size-3.5 shrink-0" />
            <span className="truncate">{data.serverName}</span>
          </span>
        </FrameFooter>
      ) : null}

      {data.hasSource ? (
        <Handle position={Position.Right} type="source" />
      ) : null}
    </Frame>
  );
}

export const topologyNodeTypes = { topology: TopologyNode };
