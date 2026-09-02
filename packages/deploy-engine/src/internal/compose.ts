import { parse } from "yaml";

import { renderComposeHttpHealthcheck } from "./deploy-policy.ts";
import { routeLabels } from "./proxy.ts";
import { composeWorkloadDeploy } from "./workload.ts";

export { SAFE_SHELL_IDENTIFIER as SAFE_COMPOSE_KEY } from "@noddle/shared/shell-identifier";

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
  const deploy = {
    ...pub.deploy,
    labels: routeLabels({
      certResolver: opts.certResolver,
      domains: opts.domains,
      port: opts.port,
      serviceName: swarmName,
    }),
  } as Record<string, unknown>;
  pub.deploy = deploy;

  if (!pub.healthcheck) {
    pub.healthcheck = renderComposeHttpHealthcheck(opts.port);
  }

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
