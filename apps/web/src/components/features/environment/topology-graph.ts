import type { DatabaseEngine } from "@noddle/database-spec";
import type { Edge } from "@xyflow/react";

import type { DependencyEdge } from "@/server/dependencies";

export type TopologyNodeKind =
  | "attach"
  | "database"
  | "internet"
  | "service"
  | "stack";

/** Where clicking the node goes — the three route params, so this module
 *  stays free of the router itself. */
export interface TopologyTarget {
  environmentId: string;
  id: string;
  projectId: string;
  resource: "databases" | "services" | "stacks";
}

export interface TopologyNodeData extends Record<string, unknown> {
  /** Attach node only: the database an attach would land on. Kept as an ID
   *  rather than a callback so node data stays plain and comparable. */
  attachTo: string | null;
  /** What you read after the status: the hostname it answers on. A database
   *  has none, and states its engine instead — same rule as the grid card. */
  address: string | null;
  /** The full URL, when the scheme is KNOWN. A Service's domain carries an
   *  `https` flag; a Stack's is a bare string, so it stays text rather than a
   *  link that 404s half the time — the same call the grid makes. */
  addressUrl: string | null;
  engine: DatabaseEngine | null;
  kind: TopologyNodeKind;
  label: string;
  /** What it reads as while an action we fired has not landed yet —
   *  "Stopping", "Deploying". Overlaid by the canvas, never by the server:
   *  the whole point is that the server still says the OLD status. */
  pending: string | null;
  /** Whether there is a container behind this to tail or shell into. A
   *  resource that has never deployed has none, and an action that opens on
   *  nothing is worse than an action that is not offered. */
  live: boolean;
  /** Whether an edge actually lands on / leaves this node. A handle that
   *  anchors nothing draws a connection point that is never used. */
  hasSource: boolean;
  hasTarget: boolean;
  /** Internet node only: how many resources it reaches, and how many of
   *  those routes Traefik terminates TLS for. The proxy's own state, which
   *  is the only thing the boundary can report about itself. */
  reaches: number | null;
  secure: number | null;
  /** Where it lives. `null` on the internet node, which lives nowhere. */
  serverName: string | null;
  status: string | null;
  target: TopologyTarget | null;
}

export interface TopologyNode {
  data: TopologyNodeData;
  id: string;
  /** Filled in by the canvas once React Flow has measured the DOM, and handed
   *  straight back to it — see `TopologyCanvas`. */
  measured?: { height: number; width: number };
  position: { x: number; y: number };
  type: "topology";
}

/**
 * What the graph reads, and nothing more.
 *
 * Declared here rather than `Pick<Scope, …>`: the dashboard rows carry
 * thirty fields each, and depending on all of them would mean fabricating
 * thirty to exercise five.
 */
export interface TopologyScope {
  databases: {
    displayName: string | null;
    engine: DatabaseEngine;
    id: string;
    name: string;
    serverName: string;
    status: string;
  }[];
  environmentId: string;
  projectId: string;
  services: {
    /** `null` = never renamed; the node reads `name`. */
    displayName: string | null;
    domains: { host: string; https: boolean }[];
    id: string;
    name: string;
    /** The container port Traefik forwards to. It cannot infer it in Swarm
     *  mode, so this is the one number a broken route usually comes down to. */
    port: number;
    serverName: string;
    status: string;
  }[];
  stacks: {
    displayName: string | null;
    domain: string | null;
    id: string;
    name: string;
    port: number | null;
    serverName: string;
    status: string;
  }[];
}

export const INTERNET_NODE_ID = "internet";

/** Statuses with no container behind them yet, or no longer. */
const NO_CONTAINER = new Set(["created", "deleting", "deploying"]);

const at = { x: 0, y: 0 };

/**
 * What Traefik actually does with the request, on the edge that carries it.
 *
 * The scheme is only claimed where it is KNOWN: a Service's domain records
 * whether TLS is on, a Stack's is a bare string and says nothing, so a stack
 * states its port alone rather than a guess.
 */
function ingressLabel(https: boolean | null, port: number | null) {
  let scheme = "";
  if (https !== null) {
    scheme = https ? "HTTPS" : "HTTP";
  }
  const target = port === null ? "" : `:${port}`;
  return [scheme, target].filter(Boolean).join(" ") || null;
}

/**
 * The environment's graph: what is reachable from outside, and what consumes
 * what.
 *
 * Two kinds of edge, and only two, because only these two are FACTS. Ingress
 * comes from the Service's own domains — Traefik routes it, so it is public.
 * Consumption comes from the stored Dependencies (ADR-0021). Nothing here
 * guesses a link from a variable's contents.
 *
 * Stacks appear without edges unless they publish a domain: a Compose stack
 * owns its own internal graph and Noddle does not read it. Drawing them is
 * still right — a topology that silently omits a deployed resource lies.
 */
export function buildTopology(
  scope: TopologyScope,
  dependencies: DependencyEdge[],
  options?: { canAttach?: boolean }
): { edges: Edge[]; nodes: TopologyNode[] } {
  const nodes: TopologyNode[] = [];
  const edges: Edge[] = [];
  const route = (
    resource: TopologyTarget["resource"],
    id: string
  ): TopologyTarget => ({
    environmentId: scope.environmentId,
    id,
    projectId: scope.projectId,
    resource,
  });

  const published = [
    ...scope.services
      .filter((s) => s.domains.length > 0)
      .map((s) => ({
        id: s.id,
        label: ingressLabel(s.domains[0]?.https ?? false, s.port),
        secure: s.domains.every((d) => d.https),
      })),
    ...scope.stacks
      .filter((s) => s.domain)
      // A Stack's domain is a bare string with no TLS flag: unknown, and an
      // unknown counted as secure would report a padlock nobody verified.
      .map((s) => ({
        id: s.id,
        label: ingressLabel(null, s.port),
        secure: false,
      })),
  ];

  if (published.length > 0) {
    nodes.push({
      data: {
        attachTo: null,
        address: null,
        addressUrl: null,
        engine: null,
        hasSource: false,
        hasTarget: false,
        kind: "internet",
        label: "Internet",
        live: false,
        reaches: published.length,
        pending: null,
        secure: published.filter((entry) => entry.secure).length,
        serverName: null,
        status: null,
        target: null,
      },
      id: INTERNET_NODE_ID,
      position: at,
      type: "topology",
    });
  }

  for (const service of scope.services) {
    const [first] = service.domains;
    nodes.push({
      data: {
        attachTo: null,
        address: first?.host ?? null,
        addressUrl: first
          ? `${first.https ? "https" : "http"}://${first.host}`
          : null,
        engine: null,
        hasSource: false,
        hasTarget: false,
        kind: "service",
        label: service.displayName ?? service.name,
        live: !NO_CONTAINER.has(service.status),
        pending: null,
        reaches: null,
        secure: null,
        serverName: service.serverName,
        status: service.status,
        target: route("services", service.id),
      },
      id: service.id,
      position: at,
      type: "topology",
    });
  }

  for (const stack of scope.stacks) {
    nodes.push({
      data: {
        attachTo: null,
        address: stack.domain,
        addressUrl: null,
        engine: null,
        hasSource: false,
        hasTarget: false,
        kind: "stack",
        label: stack.displayName ?? stack.name,
        live: !NO_CONTAINER.has(stack.status),
        pending: null,
        reaches: null,
        secure: null,
        serverName: stack.serverName,
        status: stack.status,
        target: route("stacks", stack.id),
      },
      id: stack.id,
      position: at,
      type: "topology",
    });
  }

  for (const database of scope.databases) {
    nodes.push({
      data: {
        attachTo: null,
        address: null,
        addressUrl: null,
        engine: database.engine,
        hasSource: false,
        hasTarget: false,
        kind: "database",
        label: database.displayName ?? database.name,
        live: !NO_CONTAINER.has(database.status),
        pending: null,
        reaches: null,
        secure: null,
        serverName: database.serverName,
        status: database.status,
        target: route("databases", database.id),
      },
      id: database.id,
      position: at,
      type: "topology",
    });
  }

  // Dashed against solid, because the two are not the same CLAIM: ingress is
  // derived from a domain Traefik happens to route, consumption is a fact the
  // user declared and Noddle stored.
  for (const entry of published) {
    edges.push({
      data: { dashed: true, flowing: true, label: entry.label },
      id: `ingress-${entry.id}`,
      source: INTERNET_NODE_ID,
      target: entry.id,
      type: "edge",
    });
  }

  // The server already scopes both ends to this environment, so an edge that
  // finds no node here would be a bug, not a stale row — dropped rather than
  // drawn dangling.
  const known = new Set(nodes.map((n) => n.id));
  for (const dependency of dependencies) {
    if (known.has(dependency.from) && known.has(dependency.to)) {
      edges.push({
        data: { dashed: false },
        id: `dep-${dependency.from}-${dependency.to}`,
        source: dependency.from,
        target: dependency.to,
        type: "edge",
      });
    }
  }

  // A database nothing consumes is a real state worth drawing, not an empty
  // space: the slot is shown open, and clicking it attaches a service. Only
  // when the reader may actually attach, and only when there is something to
  // attach — an invitation that cannot be accepted is worse than none.
  if (options?.canAttach && scope.services.length > 0) {
    pushAttachSlots(nodes, edges, scope.databases);
  }

  // Set LAST, not while building: a node's handles depend on the edges, and
  // the edges are only complete here.
  const sources = new Set(edges.map((e) => e.source));
  const targets = new Set(edges.map((e) => e.target));
  for (const node of nodes) {
    node.data.hasSource = sources.has(node.id);
    node.data.hasTarget = targets.has(node.id);
  }

  return { edges, nodes };
}

/**
 * An open slot beside every database nothing consumes.
 *
 * Split out of `buildTopology` for its cognitive complexity, not because it
 * stands alone: it reads the edges built so far to know what is unconsumed.
 */
function pushAttachSlots(
  nodes: TopologyNode[],
  edges: Edge[],
  databases: TopologyScope["databases"]
) {
  const consumed = new Set(edges.map((e) => e.target));
  for (const database of databases) {
    if (!consumed.has(database.id)) {
      const id = `attach-${database.id}`;
      nodes.push({
        data: {
          address: null,
          addressUrl: null,
          attachTo: database.id,
          engine: null,
          hasSource: false,
          hasTarget: false,
          kind: "attach",
          label: "Attach a service",
          live: false,
          pending: null,
          reaches: null,
          secure: null,
          serverName: null,
          status: null,
          target: null,
        },
        id,
        position: at,
        type: "topology",
      });
      edges.push({
        data: { dashed: true, ghost: true },
        id: `attach-${database.id}-edge`,
        source: id,
        target: database.id,
        type: "edge",
      });
    }
  }
}
