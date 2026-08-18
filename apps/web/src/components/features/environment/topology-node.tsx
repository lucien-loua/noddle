"use client";

import { DATABASE_ENGINE_LABEL } from "@noddle/database-spec";
import { CodeIcon, GlobeIcon, StackIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { Position } from "@xyflow/react";
import type { Node as FlowNodeType, NodeProps } from "@xyflow/react";

import { DatabaseMark } from "@/components/features/database/database-mark";
import { Handle } from "@/components/xyflow/components/handle";
import {
  Node,
  NodeDescription,
  NodeHeader,
  NodeIcon,
  NodeTitle,
} from "@/components/xyflow/components/node";
import { dotClass, serviceLabel } from "@/lib/format";
import { cn } from "@/lib/utils";

import type { TopologyNodeData, TopologyTarget } from "./topology-graph";

const KIND_ICON = {
  service: CodeIcon,
  stack: StackIcon,
} as const;

/** Measured on the rendered node, not guessed: dagre spaces ranks from
 *  these, and a wrong height opens gaps the graph does not need. */
export const TOPOLOGY_NODE_WIDTH = 288;
export const TOPOLOGY_NODE_HEIGHT = 64;

function Mark({ data }: { data: TopologyNodeData }) {
  if (data.kind === "database" && data.engine) {
    return <DatabaseMark engine={data.engine} size="sm" />;
  }
  if (data.kind === "internet") {
    return <GlobeIcon className="size-4" weight="regular" />;
  }
  const Icon = KIND_ICON[data.kind === "stack" ? "stack" : "service"];
  return <Icon className="size-4" weight="regular" />;
}

const LINK_CLASS = "outline-none hover:underline focus-visible:underline";

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

export function TopologyNode({
  data,
}: NodeProps<FlowNodeType<TopologyNodeData>>) {
  const status = data.status ? serviceLabel(data.status) : null;
  // `DatabaseMark` is `aria-hidden` on the promise that its caller names the
  // engine next to it. Written for screen readers only: on 288px the visible
  // line already carries the status and the server, and adding "PostgreSQL"
  // truncated the server name away — the mark says the engine to anyone who
  // can see it.
  const engine =
    data.kind === "database" && data.engine
      ? DATABASE_ENGINE_LABEL[data.engine]
      : null;

  return (
    <Node
      className="gap-0 py-3 shadow-sm ring-1 ring-border"
      size="sm"
      style={{ width: TOPOLOGY_NODE_WIDTH }}
    >
      {data.kind === "internet" ? null : (
        <Handle position={Position.Left} type="target" />
      )}

      <NodeHeader className="grid-cols-[auto_1fr] items-center gap-x-2.5 gap-y-0.5 px-3">
        <NodeIcon className="row-span-2 size-8 bg-muted">
          <Mark data={data} />
          {engine ? <span className="sr-only">{engine}</span> : null}
        </NodeIcon>
        <NodeTitle className="min-w-0 truncate text-sm">
          {data.target ? (
            <TargetLink label={data.label} target={data.target} />
          ) : (
            data.label
          )}
        </NodeTitle>
        <NodeDescription className="flex min-w-0 items-center gap-1.5 text-xs">
          {status ? (
            <>
              <span
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  dotClass(status.tone)
                )}
              />
              <span className="shrink-0">{status.label}</span>
            </>
          ) : null}
          {data.detail ? (
            <span className="truncate text-muted-foreground">
              {status ? "· " : null}
              {data.detail}
            </span>
          ) : null}
        </NodeDescription>
      </NodeHeader>

      {data.kind === "database" ? null : (
        <Handle position={Position.Right} type="source" />
      )}
    </Node>
  );
}

export const topologyNodeTypes = { topology: TopologyNode };
