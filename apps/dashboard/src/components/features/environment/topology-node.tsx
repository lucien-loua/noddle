"use client";

import { DATABASE_ENGINE_LABEL } from "@noddle/shared/database-spec";
import {
  ArrowClockwiseIcon,
  ArrowSquareOutIcon,
  CodeIcon,
  DatabaseIcon,
  DotsThreeIcon,
  GlobeIcon,
  HardDrivesIcon,
  PlayIcon,
  PlusIcon,
  RocketLaunchIcon,
  StopIcon,
  TrashIcon,
  ShareNetworkIcon,
  StackIcon,
  TagIcon,
  TerminalWindowIcon,
  TextAlignLeftIcon,
} from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { Position } from "@xyflow/react";
import type { Node as FlowNodeType, NodeProps } from "@xyflow/react";
import { createContext, memo, useCallback, useContext } from "react";

import { DatabaseMark } from "@/components/features/database/database-mark";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Frame,
  FrameFooter,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@/components/ui/frame";
import { StatusIndicator } from "@/components/ui/status";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Handle } from "@/components/xyflow/components/handle";
import type { Action } from "@/lib/resource-actions/use-resource-actions";

import type { TopologyNodeData, TopologyTarget } from "./topology-graph";
import { TraefikMark } from "./traefik-mark";

export const TOPOLOGY_NODE_WIDTH = 288;
export const TOPOLOGY_NODE_HEIGHT = 112;

type TopologyNodeProps = NodeProps<FlowNodeType<TopologyNodeData>>;

const NODE_STYLE = { width: TOPOLOGY_NODE_WIDTH };

const HANDLE_CLASS =
  "border-(--frame-panel-border-color)! bg-(--frame-panel-bg)!";
const HANDLE_TARGET_CLASS = `${HANDLE_CLASS} rounded-e-none! border-e-0!`;
const HANDLE_SOURCE_CLASS = `${HANDLE_CLASS} rounded-s-none! border-s-0!`;
const HANDLE_TARGET_STYLE = { left: "calc(var(--frame-px) * -1)" };
const HANDLE_SOURCE_STYLE = { right: "calc(var(--frame-px) * -1)" };

export type LifecycleKind = "database" | "service" | "stack";

export type TopologyAction =
  | { kind: "rename"; id: string; resource: LifecycleKind }
  | { kind: "attach"; databaseId: string }
  | {
      kind: "lifecycle";
      action: "delete" | "deploy" | "restart" | "start" | "stop";
      resource: LifecycleKind;
      id: string;
      name: string;
      status: string;
    }
  | { kind: "logs"; resource: "database" | "service"; id: string; name: string }
  | { kind: "routing" }
  | {
      kind: "terminal";
      resource: "database" | "service";
      id: string;
      name: string;
    };

export interface TopologyActions {
  canRename: boolean;
  canShell: boolean;
  run: (action: TopologyAction) => void;
}

const ActionsContext = createContext<TopologyActions | null>(null);

export const TopologyActionsProvider = ActionsContext.Provider;

const INTERACTIVE = "nodrag nopan";

const LINK_CLASS = `${INTERACTIVE} w-full truncate text-start outline-none after:absolute after:inset-0 hover:underline focus-visible:underline`;

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
  if (data.kind === "internet") {
    return <GlobeIcon className="size-5 shrink-0 text-muted-foreground" />;
  }
  const Icon = data.kind === "stack" ? StackIcon : CodeIcon;
  return <Icon className="size-5 shrink-0 text-muted-foreground" />;
}

function ProxyRow({
  children,
  label,
}: {
  children: React.ReactNode;
  label: string;
}) {
  return (
    <div className="flex items-center justify-between gap-2 text-sm">
      <span className="truncate text-muted-foreground">{label}</span>
      <span className="flex shrink-0 items-center gap-1.5">{children}</span>
    </div>
  );
}

function tlsState(reaches: number, secure: number) {
  if (reaches === 0 || secure === 0) {
    return { label: "Inactive", tone: "neutral" as const };
  }
  if (secure < reaches) {
    return { label: `${secure} of ${reaches}`, tone: "neutral" as const };
  }
  return { label: "Active", tone: "ok" as const };
}

function ProxyRows({ data }: { data: TopologyNodeData }) {
  const reaches = data.reaches ?? 0;
  const tls = tlsState(reaches, data.secure ?? 0);

  return (
    <>
      <ProxyRow label="Proxy">
        <TraefikMark className="size-4 shrink-0" />
        <span>Traefik</span>
      </ProxyRow>
      <ProxyRow label="Routes">
        <span className="tabular-nums">{reaches}</span>
      </ProxyRow>
      <ProxyRow label="TLS">
        <StatusIndicator className="size-2.5" tone={tls.tone} />
        <span>{tls.label}</span>
      </ProxyRow>
    </>
  );
}

function AddressText({
  data,
  engine,
}: {
  data: TopologyNodeData;
  engine: string | null;
}) {
  if (engine || !data.address) {
    return (
      <span className="truncate text-muted-foreground">
        {engine ?? "No domain"}
      </span>
    );
  }

  if (!data.addressUrl) {
    return (
      <span className="truncate text-muted-foreground">{data.address}</span>
    );
  }

  return (
    <a
      className={`${INTERACTIVE} relative z-1 inline-flex min-w-0 items-center gap-1 text-muted-foreground hover:text-foreground hover:underline`}
      href={data.addressUrl}
      rel="noreferrer noopener"
      target="_blank"
    >
      <span className="truncate">{data.address}</span>
      <ArrowSquareOutIcon className="size-3.5 shrink-0" weight="regular" />
    </a>
  );
}

function PanelRows({ data }: { data: TopologyNodeData }) {
  if (data.kind === "internet") {
    return <ProxyRows data={data} />;
  }

  const status = data.resolvedStatus;
  const engine = data.engine ? DATABASE_ENGINE_LABEL[data.engine] : null;

  return (
    <>
      {status ? (
        <div className="flex items-center gap-2 text-sm">
          <StatusIndicator className="size-2.5" tone={status.tone} />
          <span className="truncate">{status.label}</span>
        </div>
      ) : null}
      <div className="flex items-center gap-1.5 text-sm">
        {engine ? (
          <DatabaseIcon className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <GlobeIcon className="size-4 shrink-0 text-muted-foreground" />
        )}
        <AddressText data={data} engine={engine} />
      </div>
    </>
  );
}

function menuFor(
  actions: TopologyActions | null,
  data: TopologyNodeData
): {
  deployable: boolean;
  operable: boolean;
  removable: boolean;
  renamable: boolean;
} {
  return {
    deployable: data.availableActions.has("deploy"),
    operable:
      data.availableActions.has("start") || data.availableActions.has("stop"),
    removable: data.availableActions.has("delete"),
    renamable: Boolean(actions?.canRename) && data.kind !== "internet",
  };
}

function LifecycleMenu({ data }: { data: TopologyNodeData }) {
  const actions = useContext(ActionsContext);
  const id = data.target?.id ?? "";
  const resource = data.kind as LifecycleKind;
  const status = data.status ?? "";

  const fire = useCallback(
    (action: "delete" | "deploy" | "restart" | "start" | "stop") =>
      actions?.run({
        action,
        id,
        kind: "lifecycle",
        name: data.label,
        resource,
        status,
      }),
    [actions, data.label, id, resource, status]
  );

  const onDeploy = useCallback(() => fire("deploy"), [fire]);
  const onRestart = useCallback(() => fire("restart"), [fire]);
  const onStart = useCallback(() => fire("start"), [fire]);
  const onStop = useCallback(() => fire("stop"), [fire]);
  const onDelete = useCallback(() => fire("delete"), [fire]);
  const onRename = useCallback(
    () => actions?.run({ id, kind: "rename", resource }),
    [actions, id, resource]
  );

  const { deployable, operable, removable, renamable } = menuFor(actions, data);
  const stopped = status === "stopped";
  const busy = data.resolvedStatus?.tone === "busy";

  if (!(id && (deployable || operable || removable || renamable))) {
    return null;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            aria-label={`Actions for ${data.label}`}
            className={INTERACTIVE}
            disabled={busy}
            size="icon-xs"
            variant="outline"
          >
            <DotsThreeIcon weight="regular" />
          </Button>
        }
      />
      <DropdownMenuContent align="end">
        {renamable ? (
          <DropdownMenuItem onClick={onRename}>
            <TagIcon />
            Rename
          </DropdownMenuItem>
        ) : null}
        {deployable ? (
          <DropdownMenuItem onClick={onDeploy}>
            <RocketLaunchIcon />
            Deploy
          </DropdownMenuItem>
        ) : null}
        {operable ? (
          <>
            <DropdownMenuItem onClick={stopped ? onStart : onStop}>
              {stopped ? (
                <PlayIcon weight="fill" />
              ) : (
                <StopIcon weight="fill" />
              )}
              {stopped ? "Start" : "Stop"}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onRestart}>
              <ArrowClockwiseIcon weight="fill" />
              Restart
            </DropdownMenuItem>
          </>
        ) : null}
        {removable ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onDelete} variant="destructive">
              <TrashIcon />
              Delete
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function NodeActions({ data }: { data: TopologyNodeData }) {
  const actions = useContext(ActionsContext);
  const resource = data.kind === "database" ? "database" : "service";
  const { id, label, live } = { ...data, id: data.target?.id ?? "" };

  const handleRouting = useCallback(
    () => actions?.run({ kind: "routing" }),
    [actions]
  );

  const handleLogs = useCallback(
    () => actions?.run({ id, kind: "logs", name: label, resource }),
    [actions, id, label, resource]
  );
  const handleTerminal = useCallback(
    () => actions?.run({ id, kind: "terminal", name: label, resource }),
    [actions, id, label, resource]
  );

  if (data.kind === "internet") {
    return (
      <NodeAction
        icon={<ShareNetworkIcon />}
        label="Routing"
        onClick={handleRouting}
      />
    );
  }

  if (!(live && id) || data.kind === "stack") {
    return null;
  }

  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <NodeAction
        icon={<TextAlignLeftIcon />}
        label="Logs"
        onClick={handleLogs}
      />
      {actions?.canShell ? (
        <NodeAction
          icon={<TerminalWindowIcon />}
          label="Terminal"
          onClick={handleTerminal}
        />
      ) : null}
    </div>
  );
}

function NodeAction({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            className={INTERACTIVE}
            onClick={onClick}
            size="icon-xs"
            variant="outline"
          >
            {icon}
          </Button>
        }
      />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function AttachNode({ data }: { data: TopologyNodeData }) {
  const actions = useContext(ActionsContext);
  const { attachTo } = data;

  const handleClick = useCallback(() => {
    if (attachTo) {
      actions?.run({ databaseId: attachTo, kind: "attach" });
    }
  }, [actions, attachTo]);

  return (
    <Frame style={NODE_STYLE} variant="ghost">
      <div className="relative flex grow">
        <FramePanel className="border-dashed bg-transparent shadow-none before:hidden">
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <PlusIcon aria-hidden className="size-4 shrink-0" />
            <button className={LINK_CLASS} onClick={handleClick} type="button">
              {data.label}
            </button>
          </div>
        </FramePanel>

        {data.hasSource ? (
          <Handle
            className={HANDLE_SOURCE_CLASS}
            position={Position.Right}
            style={HANDLE_SOURCE_STYLE}
            type="source"
          />
        ) : null}
      </div>
    </Frame>
  );
}

function TopologyNodeBody({ data }: TopologyNodeProps) {
  if (data.kind === "attach") {
    return <AttachNode data={data} />;
  }

  return (
    <Frame style={NODE_STYLE}>
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
          <div className="relative z-1 flex shrink-0 items-center gap-0.5">
            <NodeActions data={data} />
            <LifecycleMenu data={data} />
          </div>
        </div>
      </FrameHeader>

      <div className="relative flex grow">
        {data.hasTarget ? (
          <Handle
            className={HANDLE_TARGET_CLASS}
            position={Position.Left}
            style={HANDLE_TARGET_STYLE}
            type="target"
          />
        ) : null}

        <FramePanel className="flex flex-col gap-3">
          <PanelRows data={data} />
        </FramePanel>

        {data.hasSource ? (
          <Handle
            className={HANDLE_SOURCE_CLASS}
            position={Position.Right}
            style={HANDLE_SOURCE_STYLE}
            type="source"
          />
        ) : null}
      </div>

      <NodeFooter data={data} />
    </Frame>
  );
}

function NodeFooter({ data }: { data: TopologyNodeData }) {
  if (!data.serverName) {
    return null;
  }

  return (
    <FrameFooter>
      <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
        <HardDrivesIcon aria-hidden className="size-3.5 shrink-0" />
        <span className="truncate">{data.serverName}</span>
      </span>
    </FrameFooter>
  );
}

function sameActions(a: ReadonlySet<Action>, b: ReadonlySet<Action>): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const action of a) {
    if (!b.has(action)) {
      return false;
    }
  }
  return true;
}

function sameStatus(a: TopologyNodeData, b: TopologyNodeData): boolean {
  return (
    a.resolvedStatus?.label === b.resolvedStatus?.label &&
    a.resolvedStatus?.tone === b.resolvedStatus?.tone
  );
}

function sameTarget(a: TopologyNodeData, b: TopologyNodeData): boolean {
  return (
    a.target?.id === b.target?.id && a.target?.resource === b.target?.resource
  );
}

function sameNode(a: TopologyNodeProps, b: TopologyNodeProps) {
  return (
    a.data.address === b.data.address &&
    a.data.addressUrl === b.data.addressUrl &&
    a.data.attachTo === b.data.attachTo &&
    sameActions(a.data.availableActions, b.data.availableActions) &&
    a.data.engine === b.data.engine &&
    a.data.hasSource === b.data.hasSource &&
    a.data.hasTarget === b.data.hasTarget &&
    a.data.kind === b.data.kind &&
    a.data.label === b.data.label &&
    a.data.live === b.data.live &&
    a.data.reaches === b.data.reaches &&
    sameStatus(a.data, b.data) &&
    a.data.secure === b.data.secure &&
    a.data.serverName === b.data.serverName &&
    a.data.status === b.data.status &&
    sameTarget(a.data, b.data)
  );
}

const TopologyNode = memo(TopologyNodeBody, sameNode);

TopologyNode.displayName = "TopologyNode";

export const topologyNodeTypes = { topology: TopologyNode };

export { TopologyNode };
