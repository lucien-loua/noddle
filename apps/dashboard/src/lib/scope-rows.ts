import { displayNameOf } from "@/lib/format";
import type {
  DeploymentSummary,
  Scope,
  ServiceRow,
  StackRow,
} from "@/server/dashboard";
import type { DatabaseRow } from "@/server/databases/read";

export type ResourceKind = "database" | "service" | "stack";

const IN_FLIGHT_DEPLOYMENT = new Set(["queued", "building", "deploying"]);

export interface ResourceRow {
  id: string;
  inFlightDeployment: string | null;
  kind: ResourceKind;
  label: string;
  name: string;
  serverName: string;
  status: string;
  updatedAt: string;
}

function inFlightDeploymentOf(
  deployment: DeploymentSummary | null
): string | null {
  if (
    deployment &&
    !deployment.finishedAt &&
    IN_FLIGHT_DEPLOYMENT.has(deployment.status)
  ) {
    return deployment.status;
  }
  return null;
}

export function serviceRow(s: ServiceRow): ResourceRow {
  return {
    id: s.id,
    inFlightDeployment: inFlightDeploymentOf(s.lastDeployment),
    kind: "service",
    label: displayNameOf(s),
    name: s.name,
    serverName: s.serverName,
    status: s.status,
    updatedAt: s.updatedAt,
  };
}

export function stackRow(s: StackRow): ResourceRow {
  return {
    id: s.id,
    inFlightDeployment: inFlightDeploymentOf(s.lastDeployment),
    kind: "stack",
    label: displayNameOf(s),
    name: s.name,
    serverName: s.serverName,
    status: s.status,
    updatedAt: s.updatedAt,
  };
}

export function databaseRow(d: DatabaseRow): ResourceRow {
  return {
    id: d.id,
    inFlightDeployment: null,
    kind: "database",
    label: displayNameOf(d),
    name: d.name,
    serverName: d.serverName,
    status: d.status,
    updatedAt: d.updatedAt,
  };
}

export function scopeRows(scope: Scope): ResourceRow[] {
  return [
    ...scope.services.map(serviceRow),
    ...scope.stacks.map(stackRow),
    ...scope.databases.map(databaseRow),
  ];
}
