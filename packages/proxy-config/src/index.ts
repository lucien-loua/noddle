// Hoisted to module level: a literal regex inside a function gets
// recompiled on every call, and this one is evaluated on every deployment.
const RULE_UNSAFE_CHARS = /[`"'\\]/;
const TRAILING_SLASHES = /\/+$/;

export type CertificateType = "none" | "letsencrypt";

export interface DomainRoute {
  certificateType: CertificateType;
  host: string;
  https: boolean;
  internalPath?: string | null;
  path: string;
  stripPath: boolean;
}

export interface RouteConfig {
  /**
   * ACME resolver. Absent locally: Let's Encrypt must reach the server
   * from the public internet, which is impossible on a dev VM.
   */
  certResolver?: string;
  /** Public hostnames. Absent = no exposed route. */
  domains?: string[];
  /** Traefik entrypoint. `web` over HTTP, `websecure` once TLS is active. */
  entrypoint?: string;
  /** Listening port INSIDE the container. */
  port: number;
  /** Swarm service name. Also used as the router name and Traefik service name. */
  serviceName: string;
}

export type TraefikLabels = Record<string, string>;

/** Max per-service domain routers — bounds stale label cleanup. */
export const MAX_DOMAIN_ROUTERS = 32;

function assertRuleSafe(value: string, label: string): void {
  if (RULE_UNSAFE_CHARS.test(value)) {
    throw new Error(`invalid ${label} for a Traefik rule: ${JSON.stringify(value)}`);
  }
}

function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (trimmed === "" || trimmed === "/") {
    return "/";
  }
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withSlash.replace(TRAILING_SLASHES, "") || "/";
}

export function hostRule(domains: string[]): string {
  if (domains.length === 0) {
    return "";
  }
  for (const domain of domains) {
    assertRuleSafe(domain, "domain");
  }
  if (domains.length === 1) {
    return `Host(\`${domains[0]}\`)`;
  }
  return domains.map((domain) => `Host(\`${domain}\`)`).join(" || ");
}

function domainRule(host: string, path: string): string {
  assertRuleSafe(host, "domain");
  assertRuleSafe(path, "path");
  const hostMatch = `Host(\`${host}\`)`;
  if (path === "/") {
    return hostMatch;
  }
  return `${hostMatch} && PathPrefix(\`${path}\`)`;
}

function routerLabels(
  labels: TraefikLabels,
  routerName: string,
  serviceName: string,
  rule: string,
  entrypoint: string,
  tls?: { certResolver?: string },
): void {
  labels[`traefik.http.routers.${routerName}.rule`] = rule;
  labels[`traefik.http.routers.${routerName}.entrypoints`] = entrypoint;
  labels[`traefik.http.routers.${routerName}.service`] = serviceName;
  if (tls) {
    labels[`traefik.http.routers.${routerName}.tls`] = "true";
    if (tls.certResolver) {
      labels[`traefik.http.routers.${routerName}.tls.certresolver`] = tls.certResolver;
    }
  }
}

function attachPathMiddlewares(
  labels: TraefikLabels,
  routerName: string,
  domain: DomainRoute,
): void {
  const path = normalizePath(domain.path);
  const middlewares: string[] = [];

  if (domain.stripPath && path !== "/") {
    const name = `${routerName}-strip`;
    labels[`traefik.http.middlewares.${name}.stripprefix.prefixes`] = path;
    middlewares.push(name);
  }

  const internal = domain.internalPath?.trim();
  if (internal && internal !== "" && internal !== "/") {
    const prefix = internal.startsWith("/") ? internal : `/${internal}`;
    assertRuleSafe(prefix, "internal path");
    const name = `${routerName}-add`;
    labels[`traefik.http.middlewares.${name}.addprefix.prefix`] = prefix;
    middlewares.push(name);
  }

  if (middlewares.length > 0) {
    labels[`traefik.http.routers.${routerName}.middlewares`] = middlewares.join(",");
  }
}

/** Per-domain routing — one Traefik router per hostname/path/TLS combo. */
export function serviceRouteLabels(cfg: {
  certResolver?: string;
  domains: DomainRoute[];
  port: number;
  serviceName: string;
}): TraefikLabels {
  const { serviceName, port } = cfg;

  if (cfg.domains.length === 0) {
    return { "traefik.enable": "false" };
  }

  const labels: TraefikLabels = {
    "traefik.enable": "true",
    [`traefik.http.services.${serviceName}.loadbalancer.server.port`]: String(port),
  };

  for (const [index, domain] of cfg.domains.entries()) {
    const routerName = `${serviceName}-d${index}`;
    const path = normalizePath(domain.path);
    const entrypoint = domain.https ? "websecure" : "web";
    const wantsLetsEncrypt = domain.https && domain.certificateType === "letsencrypt";

    routerLabels(
      labels,
      routerName,
      serviceName,
      domainRule(domain.host, path),
      entrypoint,
      domain.https
        ? {
            certResolver: wantsLetsEncrypt && cfg.certResolver ? cfg.certResolver : undefined,
          }
        : undefined,
    );
    attachPathMiddlewares(labels, routerName, { ...domain, path });
  }

  return labels;
}

/** Single-router labels — stacks and compose still pass plain hostnames. */
export function routeLabels(cfg: RouteConfig): TraefikLabels {
  const { serviceName, port } = cfg;
  const domains = cfg.domains ?? [];

  if (domains.length === 0) {
    return { "traefik.enable": "false" };
  }

  const entrypoint = cfg.entrypoint ?? (cfg.certResolver ? "websecure" : "web");

  const labels: TraefikLabels = {
    "traefik.enable": "true",
    [`traefik.http.routers.${serviceName}.rule`]: hostRule(domains),
    [`traefik.http.routers.${serviceName}.entrypoints`]: entrypoint,
    [`traefik.http.services.${serviceName}.loadbalancer.server.port`]: String(port),
  };

  if (cfg.certResolver) {
    labels[`traefik.http.routers.${serviceName}.tls`] = "true";
    labels[`traefik.http.routers.${serviceName}.tls.certresolver`] = cfg.certResolver;
  }

  return labels;
}

/**
 * Labels in the form expected by `docker service create --label k=v`.
 *
 * Note: on `docker service update`, labels don't move by themselves. A
 * domain change must go through `--label-add` (and `--label-rm` for the
 * old router), otherwise the old rule survives.
 */
export function toLabelArgs(labels: TraefikLabels): string[] {
  return Object.entries(labels).map(([k, v]) => `${k}=${v}`);
}

/**
 * Labels to remove when a service changes domain or stops being exposed.
 * Traefik indexes by router name: leaving the old ones in place keeps the
 * route active.
 */
export function staleRouteLabelKeys(serviceName: string): string[] {
  const routers = [serviceName, `${serviceName}-web`, `${serviceName}-websecure`];
  for (let i = 0; i < MAX_DOMAIN_ROUTERS; i += 1) {
    routers.push(`${serviceName}-d${i}`);
  }
  const keys: string[] = [];
  for (const router of routers) {
    keys.push(
      `traefik.http.routers.${router}.rule`,
      `traefik.http.routers.${router}.entrypoints`,
      `traefik.http.routers.${router}.tls`,
      `traefik.http.routers.${router}.tls.certresolver`,
      `traefik.http.routers.${router}.service`,
      `traefik.http.routers.${router}.middlewares`,
    );
  }
  for (let i = 0; i < MAX_DOMAIN_ROUTERS; i += 1) {
    const base = `${serviceName}-d${i}`;
    keys.push(
      `traefik.http.middlewares.${base}-strip.stripprefix.prefixes`,
      `traefik.http.middlewares.${base}-add.addprefix.prefix`,
    );
  }
  keys.push(`traefik.http.services.${serviceName}.loadbalancer.server.port`);
  return keys;
}
