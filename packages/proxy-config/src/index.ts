// Hoisted to module level: a literal regex inside a function gets
// recompiled on every call, and this one is evaluated on every deployment.
const RULE_UNSAFE_CHARS = /[`"'\\]/;

export interface RouteConfig {
  /**
   * ACME resolver. Absent locally: Let's Encrypt must reach the server
   * from the public internet, which is impossible on a dev VM.
   */
  certResolver?: string;
  /** Public domain. Absent = no exposed route. */
  domain?: string;
  /** Traefik entrypoint. `web` over HTTP, `websecure` once TLS is active. */
  entrypoint?: string;
  /** Listening port INSIDE the container. */
  port: number;
  /** Swarm service name. Also used as the router name and Traefik service name. */
  serviceName: string;
}

export type TraefikLabels = Record<string, string>;

/**
 * Escapes a value destined for a Traefik rule.
 *
 * The rule is text interpreted by Traefik, not by a shell: the risk isn't
 * execution but corruption of the rule. A backtick in a domain would
 * terminate it prematurely.
 */
function assertRuleSafe(domain: string): void {
  if (RULE_UNSAFE_CHARS.test(domain)) {
    throw new Error(
      `invalid domain for a Traefik rule: ${JSON.stringify(domain)}`
    );
  }
}

export function routeLabels(cfg: RouteConfig): TraefikLabels {
  const { serviceName, domain, port } = cfg;

  // Without a domain, the service runs but isn't exposed. That's a
  // legitimate case (worker, cron) — traefik.enable=true must absolutely
  // not be set with an empty rule, or Traefik would route just about
  // anything to it.
  if (!domain) {
    return { "traefik.enable": "false" };
  }

  assertRuleSafe(domain);
  // A cert resolver implies the TLS entrypoint: requesting a certificate
  // for a router that only listens in plaintext produces a perfectly
  // valid router, a genuinely issued certificate, and zero HTTPS — a
  // failure that only shows up when typing the URL with https.
  const entrypoint = cfg.entrypoint ?? (cfg.certResolver ? "websecure" : "web");

  const labels: TraefikLabels = {
    "traefik.enable": "true",
    [`traefik.http.routers.${serviceName}.rule`]: `Host(\`${domain}\`)`,
    [`traefik.http.routers.${serviceName}.entrypoints`]: entrypoint,
    // Mandatory in Swarm mode. Without it, Traefik registers the router
    // then fails to reach the service, which shows up as a 502.
    [`traefik.http.services.${serviceName}.loadbalancer.server.port`]:
      String(port),
  };

  if (cfg.certResolver) {
    labels[`traefik.http.routers.${serviceName}.tls`] = "true";
    labels[`traefik.http.routers.${serviceName}.tls.certresolver`] =
      cfg.certResolver;
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
  return [
    `traefik.http.routers.${serviceName}.rule`,
    `traefik.http.routers.${serviceName}.entrypoints`,
    `traefik.http.routers.${serviceName}.tls`,
    `traefik.http.routers.${serviceName}.tls.certresolver`,
    `traefik.http.services.${serviceName}.loadbalancer.server.port`,
  ];
}
