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
