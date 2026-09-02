export {
  buildImage,
  buildImageFromDockerfile,
  computeBuildCap,
  ensureCappedBuilder,
  fetchSource,
  resolveBuildDir,
} from "./internal/build.ts";
export {
  type ComposeBuildSpec,
  type ComposeFile,
  type ComposeService,
  injectDeployConfig,
  listComposeServiceKeys,
  parseCompose,
  SAFE_COMPOSE_KEY,
} from "./internal/compose.ts";
export { SECOND_NS } from "./internal/deploy-policy.ts";
export {
  type DomainRoute,
  routeLabels,
  serviceRouteLabels,
  type TraefikLabels,
} from "./internal/proxy.ts";
export {
  isPortableImage,
  pushImage,
  REGISTRY_USER,
  type RegistryConfig,
  registryImageTag,
} from "./internal/registry.ts";
export {
  awaitSwarmVerdict,
  deployService,
  ensureOverlayNetwork,
  getSwarmNodeId,
  isDeployAccepted,
  readRunningNodeId,
  type RegistryAuth,
  type SwarmUpdateState,
} from "./internal/swarm.ts";
export {
  inspectServiceHealth,
  WATCH_WINDOW_MS,
  watchUntilFor,
} from "./internal/watch.ts";
export { dockerodeWorkloadPolicy } from "./internal/workload.ts";
