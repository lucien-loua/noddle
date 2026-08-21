"use client";

import { DATABASE_ENGINE_LABEL } from "@noddle/database-spec";
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Handle } from "@/components/xyflow/components/handle";
import { dotClass, serviceLabel } from "@/lib/format";

import type { TopologyNodeData, TopologyTarget } from "./topology-graph";
import { TraefikMark } from "./traefik-mark";

/** ESTIMATES: dagre spaces ranks from these, then the canvas hands back the
 *  heights it actually measured for an exact second pass. */
export const TOPOLOGY_NODE_WIDTH = 288;
export const TOPOLOGY_NODE_HEIGHT = 112;

type TopologyNodeProps = NodeProps<FlowNodeType<TopologyNodeData>>;

const NODE_STYLE = { width: TOPOLOGY_NODE_WIDTH };

/**
 * The handle is a tab of the PANEL, not of the frame.
 *
 * It takes the panel's own fill and border and opens on the side that meets
 * it, so the two read as one shape; the offset pulls it back out by the
 * frame's padding so it still clears the card. Behind a `bg-muted/50` frame it
 * used to show THROUGH, which read as a pill lying under the node.
 */
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

/** Facts about the READER, identical for every node, so they travel with the
 *  callback rather than being copied into thirty node data objects. */
export interface TopologyActions {
  canDelete: boolean;
  canDeploy: boolean;
  canOperateDatabase: boolean;
  canRename: boolean;
  canShell: boolean;
  run: (action: TopologyAction) => void;
}

/**
 * How a node reaches the drawer.
 *
 * A callback in node `data` would make the data uncomparable and stop `memo`
 * from ever skipping a render; context keeps `data` plain and serialisable,
 * and one stable value serves every node.
 */
const ActionsContext = createContext<TopologyActions | null>(null);

export const TopologyActionsProvider = ActionsContext.Provider;

/**
 * React Flow claims pointer events inside a node for panning and dragging, so
 * every control has to opt out by class name or the click lands on the canvas
 * instead — measured: the dropdown never opened and the graph panned under
 * the cursor. `nodesDraggable={false}` does not cover this; it stops the NODE
 * moving, not the pane.
 */
const INTERACTIVE = "nodrag nopan";

const LINK_CLASS = `${INTERACTIVE} w-full truncate text-start outline-none after:absolute after:inset-0 hover:underline focus-visible:underline`;

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
 * The panel says HOW IT IS DOING — except on the internet node, which has no
 * status to state and answers the only question it can: how much of the
 * environment it reaches.
 */
/** `label — value` on one line, the shape every proxy row shares. */
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

/**
 * What TLS is doing across every published route.
 *
 * Three states and not two: "some of them" is the one worth catching, and an
 * `Active` covering two routes out of three would be a lie told by a padlock.
 */
function tlsState(reaches: number, secure: number) {
  if (reaches === 0 || secure === 0) {
    return { label: "Inactive", tone: "neutral" as const };
  }
  if (secure < reaches) {
    return { label: `${secure} of ${reaches}`, tone: "neutral" as const };
  }
  return { label: "Active", tone: "ok" as const };
}

/**
 * The boundary, in the grammar Traefik itself works in: how many routers are
 * defined, and whether they terminate TLS. It is the one node reporting a
 * PROXY rather than a resource, so it states the proxy's own configuration.
 */
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
        <span
          aria-hidden
          className={`size-2.5 rounded-full ${dotClass(tls.tone)}`}
        />
        <span>{tls.label}</span>
      </ProxyRow>
    </>
  );
}

function pendingOrActual(data: TopologyNodeData) {
  if (data.pending) {
    return { label: data.pending, tone: "busy" as const };
  }
  return data.status ? serviceLabel(data.status) : null;
}

/**
 * The hostname, as a link when the scheme is known.
 *
 * `relative z-1` for the same reason the header actions carry it: the title
 * is a stretched link over the whole card, and an anchor underneath it is
 * unclickable — the click would silently open the detail page instead of the
 * site.
 */
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

  // The optimistic label wins over the server's: between the click and the
  // status moving, the server is the one that is wrong.
  const status = pendingOrActual(data);
  const engine = data.engine ? DATABASE_ENGINE_LABEL[data.engine] : null;

  return (
    <>
      {status ? (
        // A dot, not a badge: on a canvas you scan shapes, and a disc in a
        // fixed position reads without being read. The word stays beside it —
        // colour is never the only channel.
        <div className="flex items-center gap-2 text-sm">
          <span
            aria-hidden
            className={`size-2.5 shrink-0 rounded-full ${dotClass(status.tone)}`}
          />
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

/**
 * Everything you can do to a resource without leaving the graph.
 *
 * The same set the resource grid offers, gated the same way — a canvas that
 * let you stop what the grid would not is a permission hole with a nicer
 * layout. A stack is SEVERAL Swarm services under one namespace and
 * `runLifecycle` has nothing that scales them together, so it is deployed and
 * deleted only.
 */
function menuFor(
  actions: TopologyActions | null,
  data: TopologyNodeData
): {
  deployable: boolean;
  operable: boolean;
  removable: boolean;
  renamable: boolean;
} {
  const mayOperate =
    data.kind === "database" ? actions?.canOperateDatabase : actions?.canDeploy;
  return {
    deployable: Boolean(actions?.canDeploy) && data.kind !== "database",
    operable: Boolean(mayOperate) && data.live && data.kind !== "stack",
    removable: Boolean(actions?.canDelete),
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
  const busy = data.pending !== null;

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

/**
 * The row of quick actions in a node's header.
 *
 * `relative z-1`, and not for stacking taste: the title above is a STRETCHED
 * link — `after:inset-0` over the whole frame — and without a positioned
 * ancestor here every one of these clicks would land on it instead.
 */
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

  // A stack is SEVERAL Swarm services under one namespace: there is no single
  // container to tail or shell into, and no API that pretends otherwise.
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

/** The open slot on a database nothing consumes: dashed, because it is not a
 *  resource — it is the absence of one, drawn where one would go. */
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

/**
 * One resource on the canvas, in the grid card's own grammar: the header says
 * WHAT this is, the panel says HOW IT IS DOING, the footer says WHERE IT
 * LIVES. Written on `Frame` rather than the flow template's `Node`, so a
 * resource looks the same whichever screen draws it.
 *
 * The handles are anchored to the panel rather than to the frame: it is what
 * an edge lands ON, and centring them on the frame put them off the panel's
 * centre line by the difference between the header and the footer.
 */
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
          {/* `relative z-1`, and not for stacking taste: the title beside it
              is a STRETCHED link — `after:inset-0` over the whole frame — and
              without a positioned ancestor every click here would land on it
              instead. */}
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

/** Where it lives, and nothing else — the actions moved up to the header,
 *  where the name they act on is. */
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

/** Compared field by field rather than on `data` identity: `buildTopology`
 *  allocates fresh objects on every pass, so one service changing status would
 *  otherwise re-render every card on the canvas. */
function sameNode(a: TopologyNodeProps, b: TopologyNodeProps) {
  return (
    a.data.address === b.data.address &&
    a.data.addressUrl === b.data.addressUrl &&
    a.data.attachTo === b.data.attachTo &&
    a.data.engine === b.data.engine &&
    a.data.hasSource === b.data.hasSource &&
    a.data.hasTarget === b.data.hasTarget &&
    a.data.kind === b.data.kind &&
    a.data.label === b.data.label &&
    a.data.live === b.data.live &&
    a.data.pending === b.data.pending &&
    a.data.reaches === b.data.reaches &&
    a.data.secure === b.data.secure &&
    a.data.serverName === b.data.serverName &&
    a.data.status === b.data.status &&
    a.data.target?.id === b.data.target?.id &&
    a.data.target?.resource === b.data.target?.resource
  );
}

const TopologyNode = memo(TopologyNodeBody, sameNode);

TopologyNode.displayName = "TopologyNode";

export const topologyNodeTypes = { topology: TopologyNode };

export { TopologyNode };
