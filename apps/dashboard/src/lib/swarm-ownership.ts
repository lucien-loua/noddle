import { swarmServiceName } from "@noddle/shared/swarm-names";

import type { ContainerKind } from "@/lib/container-read.server";

export interface SwarmNames {
  exact: ReadonlySet<string>;
  stacks: readonly string[];
}

export function toSwarmNames(rows: {
  databases: { swarmName: string }[];
  services: { id: string; name: string }[];
  stacks: { swarmName: string }[];
}): SwarmNames {
  return {
    exact: new Set([
      ...rows.services.map((service) => swarmServiceName(service)),
      ...rows.databases.map((database) => database.swarmName),
    ]),
    stacks: rows.stacks.map((stack) => stack.swarmName),
  };
}

export function ownsSwarmService(
  names: SwarmNames,
  serviceName: string | null
): boolean {
  if (!serviceName) {
    return false;
  }
  if (names.exact.has(serviceName)) {
    return true;
  }
  return names.stacks.some(
    (stack) => serviceName === stack || serviceName.startsWith(`${stack}_`)
  );
}

export function containerVisibleTo(
  scope: SwarmNames | null,
  container: { kind: ContainerKind; serviceName: string | null }
): boolean {
  if (scope === null) {
    return true;
  }
  return (
    container.kind === "swarm" && ownsSwarmService(scope, container.serviceName)
  );
}
