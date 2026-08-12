import {
  type DomainRoute,
  routeLabels,
  serviceRouteLabels,
} from "@noddle/proxy-config";
import type { RegistryConfig } from "@noddle/registry";
import type { DockerApi } from "@noddle/ssh-executor";
import {
  deployService,
  ensureOverlayNetwork,
  isDeployAccepted,
  readRunningNodeId,
  type SwarmUpdateState,
} from "@noddle/swarm-ops";
import { authFor, placementFor } from "#deploy/placement";

export interface RolloutInput {
  buildDocker: DockerApi;
  certResolver?: string;
  domainRoutes?: DomainRoute[];
  /** Plain hostnames — stacks and compose paths without per-domain TLS. */
  domains?: string[];
  env: Record<string, string>;
  image: string;
  managerDocker: DockerApi;
  networkName: string;
  port: number;
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

/**
 * Pin (if needed), ensure the overlay, roll the Swarm service, and read
 * back where the task actually landed.
 *
 * This is the shared core of a fresh ship and a rollback/watch revert:
 * both paths already hold an image tag and decrypted env — only the
 * provenance of that tag differs (just-built vs history).
 */
export async function rolloutService(
  input: RolloutInput
): Promise<RolloutResult> {
  const placementNodeId = await placementFor({
    buildDocker: input.buildDocker,
    image: input.image,
    registry: input.registry,
    swarmNodeId: input.swarmNodeId,
  });

  await ensureOverlayNetwork(input.managerDocker, input.networkName);

  const outcome = await deployService(input.managerDocker, {
    // The healthcheck and Traefik both target `port`. Apps that read
    // `process.env.PORT` (Heroku, nixpacks, Express) must listen there —
    // a user env var named PORT would otherwise desync the probe.
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

  const accepted = isDeployAccepted(outcome.updateState);
  return {
    accepted,
    nodeId: accepted
      ? await readRunningNodeId(input.managerDocker, input.serviceName)
      : null,
    updateMessage: outcome.updateMessage,
    updateState: outcome.updateState,
  };
}
