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
export {
  type DomainRoute,
  routeLabels,
  serviceRouteLabels,
  type TraefikLabels,
} from "./internal/proxy.ts";
export {
  deleteManifest,
  ensureRegistryTrust,
  garbageCollect,
  isPortableImage,
  KEEP_PER_SERVICE,
  parseRegistryRef,
  pushImage,
  REGISTRY_USER,
  type RegistryConfig,
  registryImageTag,
} from "./internal/registry.ts";
