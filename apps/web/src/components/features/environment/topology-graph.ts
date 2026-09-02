import type { DatabaseEngine } from "@noddle/database-spec";
import type { Edge } from "@xyflow/react";

import type { Tone } from "@/lib/format";
import type { Action } from "@/lib/resource-actions/use-resource-actions";
import type { DependencyEdge } from "@/server/dependencies";

export type TopologyNodeKind =
  | "attach"
  | "database"
  | "internet"
  | "service"
  | "stack";

export interface TopologyTarget {
  environmentId: string;
  id: string;
  projectId: string;
  resource: "databases" | "services" | "stacks";
}

export interface TopologyNodeData extends Record<string, unknown> {
  attachTo: string | null;
  address: string | null;
  addressUrl: string | null;
  availableActions: ReadonlySet<Action>;
  engine: DatabaseEngine | null;
  kind: TopologyNodeKind;
  label: string;
  resolvedStatus: { label: string; tone: Tone } | null;
  live: boolean;
  hasSource: boolean;
  hasTarget: boolean;
  reaches: number | null;
  secure: number | null;
  serverName: string | null;
  status: string | null;
  target: TopologyTarget | null;
}

export interface TopologyNode {
  data: TopologyNodeData;
  id: string;
  measured?: { height: number; width: number };
  position: { x: number; y: number };
  type: "topology";
}

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
    displayName: string | null;
    domains: { host: string; https: boolean }[];
    id: string;
    name: string;
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

const NO_ACTIONS: ReadonlySet<Action> = new Set();

const NO_CONTAINER = new Set(["created", "deleting", "deploying"]);

const at = { x: 0, y: 0 };

function ingressLabel(https: boolean | null, port: number | null) {
  let scheme = "";
  if (https !== null) {
    scheme = https ? "HTTPS" : "HTTP";
  }
  const target = port === null ? "" : `:${port}`;
  return [scheme, target].filter(Boolean).join(" ") || null;
}

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
        availableActions: NO_ACTIONS,
        resolvedStatus: null,
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
        availableActions: NO_ACTIONS,
        resolvedStatus: null,
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
        availableActions: NO_ACTIONS,
        resolvedStatus: null,
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
        availableActions: NO_ACTIONS,
        resolvedStatus: null,
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

  for (const entry of published) {
    edges.push({
      data: { dashed: true, flowing: true, label: entry.label },
      id: `ingress-${entry.id}`,
      source: INTERNET_NODE_ID,
      target: entry.id,
      type: "edge",
    });
  }

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

  if (options?.canAttach && scope.services.length > 0) {
    pushAttachSlots(nodes, edges, scope.databases);
  }

  const sources = new Set(edges.map((e) => e.source));
  const targets = new Set(edges.map((e) => e.target));
  for (const node of nodes) {
    node.data.hasSource = sources.has(node.id);
    node.data.hasTarget = targets.has(node.id);
  }

  return { edges, nodes };
}

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
          availableActions: NO_ACTIONS,
          resolvedStatus: null,
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
