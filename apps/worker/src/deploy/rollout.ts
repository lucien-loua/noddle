import { routeLabels, serviceRouteLabels } from "@noddle/deploy-engine";
import type { DomainRoute } from "@noddle/deploy-engine";
import type { RegistryConfig } from "@noddle/registry";
import type { DockerApi } from "@noddle/ssh-executor";
import {
  deployService,
  ensureOverlayNetwork,
  readRunningNodeId,
} from "@noddle/swarm-ops";
import type { SwarmUpdateState } from "@noddle/swarm-ops";

import { authFor, placementFor } from "#deploy/placement";

export interface RolloutInput {
  buildDocker: DockerApi;
  certResolver?: string;
  domainRoutes?: DomainRoute[];
  domains?: string[];
  env: Record<string, string>;
  image: string;
  managerDocker: DockerApi;
  networkName: string;
  port: number;
  portable?: boolean;
  registry: RegistryConfig | undefined;
  serviceName: string;
  swarmNodeId: string | null | undefined;
}

export interface RolloutResult {
  accepted: boolean;
  nodeId: string | null;
  updateMessage: string | null | undefined;
  updateState: SwarmUpdateState | null;
}

export async function rolloutService(
  input: RolloutInput
): Promise<RolloutResult> {
  const placementNodeId = input.portable
    ? undefined
    : await placementFor({
        buildDocker: input.buildDocker,
        image: input.image,
        registry: input.registry,
        swarmNodeId: input.swarmNodeId,
      });

  await ensureOverlayNetwork(input.managerDocker, input.networkName);

  const outcome = await deployService(input.managerDocker, {
    env: { ...input.env, PORT: String(input.port) },
    image: input.image,
    labels:
      input.domainRoutes === undefined
        ? routeLabels({
            certResolver: input.certResolver,
            domains: input.domains,
            port: input.port,
            serviceName: input.serviceName,
          })
        : serviceRouteLabels({
            certResolver: input.certResolver,
            domains: input.domainRoutes,
            port: input.port,
            serviceName: input.serviceName,
          }),
    networkName: input.networkName,
    placementNodeId,
    port: input.port,
    registryAuth: authFor(input.registry),
    serviceName: input.serviceName,
  });

  const { accepted } = outcome;
  return {
    accepted,
    nodeId: accepted
      ? await readRunningNodeId(input.managerDocker, input.serviceName)
      : null,
    updateMessage: outcome.updateMessage,
    updateState: outcome.updateState,
  };
}
