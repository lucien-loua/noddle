import { routeLabels } from "@noddle/proxy-config";
import { renderComposeHttpHealthcheck } from "@noddle/shared/deploy-policy";
import { composeWorkloadDeploy } from "@noddle/shared/workload";
import { parse } from "yaml";

/** Typed just enough for what Noddle reads and rewrites. */
export interface ComposeBuildSpec {
  context?: string;
  dockerfile?: string;
}

export interface ComposeService {
  build?: ComposeBuildSpec | string;
  deploy?: Record<string, unknown>;
  healthcheck?: unknown;
  image?: string;
  networks?: Record<string, unknown> | string[];
  [key: string]: unknown;
}

export interface ComposeFile {
  networks?: Record<string, unknown>;
  services?: Record<string, ComposeService>;
  [key: string]: unknown;
}

/**
 * A compose key accepted as-is in a Swarm service name
 * (`${stackName}_${key}`) and in an image tag. A compose file comes from
 * the user: never a constant from the code.
 */
export const SAFE_COMPOSE_KEY = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export function parseCompose(text: string, path: string): ComposeFile {
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid compose file (${path}): ${message}`, {
      cause: error,
    });
  }
  if (typeof doc !== "object" || doc === null || !("services" in doc)) {
    throw new Error(`compose file has no "services" section (${path})`);
  }
  return doc as ComposeFile;
}

/**
 * The service keys of a stored `stack_deployments.compose_source` — used
 * by watch/sweep to know WHICH Swarm services to inspect.
 */
export function listComposeServiceKeys(composeSource: string): string[] {
  const doc = parseCompose(composeSource, "(stored)");
  return Object.keys(doc.services ?? {});
}

export interface InjectOptions {
  builtKeys: readonly string[];
  certResolver?: string;
  domains?: string[];
  networkName: string;
  placementNodeId?: string;
  port?: number | null;
  publicService?: string | null;
  stackName: string;
}

/**
 * Same guarantee as `serviceSpec()` for a single service, expressed in YAML:
 * `docker stack deploy` translates `deploy.update_config` /
 * `deploy.rollback_config` into the same Swarm API. Applied to EVERY service
 * Noddle builds — not just the public one — because a healthy, zero-downtime
 * rollout is the guarantee Noddle sells.
 */
export function injectDeployConfig(
  doc: ComposeFile,
  opts: InjectOptions
): void {
  const services = doc.services ?? {};

  for (const key of opts.builtKeys) {
    const svc = services[key];
    if (!svc) {
      continue;
    }
    const deploy = { ...svc.deploy } as Record<string, unknown>;

    const deployPolicy = composeWorkloadDeploy();
    if (opts.placementNodeId) {
      deploy.placement = {
        constraints: [`node.id==${opts.placementNodeId}`],
      };
    }
    deploy.update_config = deployPolicy.update_config;
    deploy.rollback_config = deployPolicy.rollback_config;
    deploy.restart_policy = deployPolicy.restart_policy;
    svc.deploy = deploy;
  }

  if (!(opts.publicService && opts.port !== null && opts.port !== undefined)) {
    return;
  }
  const pub = services[opts.publicService];
  if (!pub) {
    return;
  }

  const swarmName = `${opts.stackName}_${opts.publicService}`;
  const deploy = { ...pub.deploy } as Record<string, unknown>;
  deploy.labels = routeLabels({
    certResolver: opts.certResolver,
    domains: opts.domains,
    port: opts.port,
    serviceName: swarmName,
  });
  pub.deploy = deploy;

  // curl is present in most Node/Python
  // images; wget isn't and node isn't on a non-login shell's PATH — same
  // pitfall as `serviceSpec()`. We only inject it if the user doesn't
  // already have their own healthcheck: theirs takes priority.
  if (!pub.healthcheck) {
    pub.healthcheck = renderComposeHttpHealthcheck(opts.port);
  }

  // The public service must join the overlay network Traefik listens on,
  // IN ADDITION TO the stack's internal network — the stack's other
  // containers still need to keep reaching each other normally.
  doc.networks = {
    ...doc.networks,
    [opts.networkName]: { external: true },
  };
  if (Array.isArray(pub.networks)) {
    if (!pub.networks.includes(opts.networkName)) {
      pub.networks = [...pub.networks, opts.networkName];
    }
  } else if (pub.networks && typeof pub.networks === "object") {
    pub.networks = { ...pub.networks, [opts.networkName]: null };
  } else {
    pub.networks = [opts.networkName];
  }
}
