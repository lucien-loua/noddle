import type { DatabaseEngine } from "@noddle/database-spec";
import type { Edge } from "@xyflow/react";

import type { DependencyEdge } from "@/server/dependencies";

export type TopologyNodeKind = "database" | "internet" | "service" | "stack";

/** Where clicking the node goes — the three route params, so this module
 *  stays free of the router itself. */
export interface TopologyTarget {
  environmentId: string;
  id: string;
  projectId: string;
  resource: "databases" | "services" | "stacks";
}

export interface TopologyNodeData extends Record<string, unknown> {
  /** What you read after the status: the hostname it answers on. A database
   *  has none, and states its engine instead — same rule as the grid card. */
  address: string | null;
  engine: DatabaseEngine | null;
  kind: TopologyNodeKind;
  label: string;
  /** Whether an edge actually lands on / leaves this node. A handle that
   *  anchors nothing draws a connection point that is never used. */
  hasSource: boolean;
  hasTarget: boolean;
  /** Where it lives. `null` on the internet node, which lives nowhere. */
  serverName: string | null;
  status: string | null;
  target: TopologyTarget | null;
}

export interface TopologyNode {
  data: TopologyNodeData;
  id: string;
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
    engine: DatabaseEngine;
    id: string;
    name: string;
    serverName: string;
    status: string;
  }[];
  environmentId: string;
  projectId: string;
  services: {
    domains: { host: string }[];
    id: string;
    name: string;
    serverName: string;
    status: string;
  }[];
  stacks: {
    domain: string | null;
    id: string;
    name: string;
    serverName: string;
    status: string;
  }[];
}

export const INTERNET_NODE_ID = "internet";

const at = { x: 0, y: 0 };

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
  dependencies: DependencyEdge[]
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
    ...scope.services.filter((s) => s.domains.length > 0).map((s) => s.id),
    ...scope.stacks.filter((s) => s.domain).map((s) => s.id),
  ];

  if (published.length > 0) {
    nodes.push({
      data: {
        address: null,
        engine: null,
        hasSource: false,
        hasTarget: false,
        kind: "internet",
        label: "Internet",
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
    nodes.push({
      data: {
        address: service.domains[0]?.host ?? null,
        engine: null,
        hasSource: false,
        hasTarget: false,
        kind: "service",
        label: service.name,
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
        address: stack.domain,
        engine: null,
        hasSource: false,
        hasTarget: false,
        kind: "stack",
        label: stack.name,
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
        address: null,
        engine: database.engine,
        hasSource: false,
        hasTarget: false,
        kind: "database",
        label: database.name,
        serverName: database.serverName,
        status: database.status,
        target: route("databases", database.id),
      },
      id: database.id,
      position: at,
      type: "topology",
    });
  }

  for (const id of published) {
    edges.push({
      id: `ingress-${id}`,
      source: INTERNET_NODE_ID,
      target: id,
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
        id: `dep-${dependency.from}-${dependency.to}`,
        source: dependency.from,
        target: dependency.to,
        type: "edge",
      });
    }
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
