import { randomUUID } from "node:crypto";

import type { DockerApi, SshClient } from "@noddle/ssh-executor";
import { execArgv, writeRemoteFile } from "@noddle/ssh-executor";
import { stringify as stringifyYaml } from "yaml";

import {
  buildImageFromDockerfile,
  computeBuildCap,
  ensureCappedBuilder,
  fetchSource,
} from "./build.ts";
import {
  injectDeployConfig,
  parseCompose,
  SAFE_COMPOSE_KEY,
} from "./compose.ts";
import type {
  ComposeBuildSpec,
  ComposeFile,
  ComposeService,
} from "./compose.ts";
import { resolvePlacement } from "./placement.ts";
import { awaitSwarmVerdict, ensureOverlayNetwork } from "./swarm.ts";

export interface ShipStackSource {
  branch: string;
  commitSha?: string;
  repoUrl: string;
}

export type ShipStackBuild =
  | {
      composeFilePath: string;
      composeSource: string;
      kind: "resolved";
      serviceImages: Record<string, string>;
    }
  | {
      composeFilePath: string;
      kind: "git";
      repoDir: string;
      source: ShipStackSource;
      totalMemoryMb: number;
    };

export interface ShipStackTarget {
  certResolver?: string;
  domain?: string;
  networkName: string;
  port: number | null;
  publicService: string | null;
  stackName: string;
  swarmNodeId: string | null;
}

export interface ShipStackClients {
  buildClient: SshClient;
  buildDocker: DockerApi;
  createDockerApi: (client: SshClient) => DockerApi;
  managerClient: SshClient;
}

export interface ShipStackIo {
  onCommitResolved?: (commitSha: string) => Promise<void> | void;
  onComposeRead?: (composeSource: string) => Promise<void> | void;
  onLog?: (line: string) => void;
  onServicesBuilt?: (
    serviceImages: Record<string, string>
  ) => Promise<void> | void;
}

export interface ShipStackVerdict {
  accepted: boolean;
  swarmUpdateStates: Record<string, string | null>;
}

async function buildComposeServices(opts: {
  buildClient: SshClient;
  onServiceStart?: (key: string) => void;
  services: Record<string, ComposeService>;
  sha: string;
  stackName: string;
  stream: { onStderr: (s: string) => void; onStdout: (s: string) => void };
  workDir: string;
}): Promise<Record<string, string>> {
  const serviceImages: Record<string, string> = {};

  for (const [key, svc] of Object.entries(opts.services)) {
    if (!SAFE_COMPOSE_KEY.test(key)) {
      throw new Error(`compose service name refused: ${JSON.stringify(key)}`);
    }
    if (!svc.build) {
      continue;
    }
    const buildSpec: ComposeBuildSpec =
      typeof svc.build === "string" ? { context: svc.build } : svc.build;
    const contextDir = `${opts.workDir}/${buildSpec.context ?? "."}`;
    const dockerfilePath = buildSpec.dockerfile ?? "Dockerfile";
    const imageTag = `${opts.stackName}-${key}:${opts.sha.slice(0, 12)}-${Date.now()}`;

    opts.onServiceStart?.(key);
    await buildImageFromDockerfile(opts.buildClient, {
      contextDir,
      dockerfilePath,
      imageTag,
      ...opts.stream,
    });

    serviceImages[key] = imageTag;
    const { build: _build, ...rest } = svc;
    opts.services[key] = { ...rest, image: imageTag };
  }

  return serviceImages;
}

function applyResolvedImages(
  services: Record<string, ComposeService>,
  serviceImages: Record<string, string>
): void {
  for (const [key, tag] of Object.entries(serviceImages)) {
    const svc = services[key];
    if (svc) {
      const { build: _build, ...rest } = svc;
      services[key] = { ...rest, image: tag };
    }
  }
}

async function writeAndDeployStack(opts: {
  createDockerApi: (client: SshClient) => DockerApi;
  doc: ComposeFile;
  managerClient: SshClient;
  networkName: string;
  stackName: string;
  stream: { onStderr: (s: string) => void; onStdout: (s: string) => void };
}): Promise<ShipStackVerdict> {
  const { createDockerApi, managerClient, stackName, doc } = opts;
  const managerDocker = createDockerApi(managerClient);
  await ensureOverlayNetwork(managerDocker, opts.networkName);

  const serviceKeys = Object.keys(doc.services ?? {});

  const existingList = await managerDocker.listServices({
    filters: JSON.stringify({ name: [stackName] }),
  });
  const existing = new Set(
    existingList.map((s) => s.Spec?.Name).filter((n): n is string => Boolean(n))
  );

  const tmpPath = `/tmp/noddle-stack-${randomUUID()}.yml`;
  await writeRemoteFile(managerClient, tmpPath, stringifyYaml(doc));

  try {
    const result = await execArgv(
      managerClient,
      [
        "sudo",
        "docker",
        "stack",
        "deploy",
        "--resolve-image",
        "never",
        "-c",
        tmpPath,
        stackName,
      ],
      opts.stream
    );
    if (result.code !== 0) {
      throw new Error(
        `docker stack deploy failed (code ${result.code})\n${(result.stderr || result.stdout).trim()}`
      );
    }

    const swarmUpdateStates: Record<string, string | null> = {};
    let accepted = true;
    for (const key of serviceKeys) {
      const swarmName = `${stackName}_${key}`;
      const verdict = await awaitSwarmVerdict(managerDocker, swarmName, {
        created: !existing.has(swarmName),
      });
      swarmUpdateStates[key] = verdict.updateState;
      if (!verdict.accepted) {
        accepted = false;
      }
    }
    return { accepted, swarmUpdateStates };
  } finally {
    await execArgv(managerClient, ["rm", "-f", tmpPath]).catch(() => undefined);
  }
}

export async function shipStack(
  build: ShipStackBuild,
  target: ShipStackTarget,
  clients: ShipStackClients,
  io: ShipStackIo = {}
): Promise<ShipStackVerdict> {
  const log = io.onLog ?? (() => undefined);
  const stream = { onStderr: log, onStdout: log };

  let doc: ComposeFile;
  let serviceImages: Record<string, string>;

  if (build.kind === "resolved") {
    const { serviceImages: resolvedImages } = build;
    doc = parseCompose(build.composeSource, build.composeFilePath);
    serviceImages = resolvedImages;
    applyResolvedImages(doc.services ?? {}, serviceImages);
  } else {
    const cap = computeBuildCap({ totalMemoryMb: build.totalMemoryMb });
    log(`▸ build capped at ${cap.memory}\n`);
    await ensureCappedBuilder(clients.buildClient, cap, stream);

    const sha = await fetchSource(clients.buildClient, {
      branch: build.source.branch,
      commitSha: build.source.commitSha,
      dir: build.repoDir,
      repoUrl: build.source.repoUrl,
      ...stream,
    });
    await io.onCommitResolved?.(sha);

    const composePath = `${build.repoDir}/${build.composeFilePath}`;
    const catResult = await execArgv(clients.buildClient, ["cat", composePath]);
    if (catResult.code !== 0) {
      throw new Error(`compose file not found: ${build.composeFilePath}`);
    }
    const rawText = catResult.stdout;
    await io.onComposeRead?.(rawText);

    doc = parseCompose(rawText, build.composeFilePath);
    const services = doc.services ?? {};

    log("▸ building services\n");
    serviceImages = await buildComposeServices({
      buildClient: clients.buildClient,
      onServiceStart: (key) => log(`▸ ${key}\n`),
      services,
      sha,
      stackName: target.stackName,
      stream,
      workDir: build.repoDir,
    });
    await io.onServicesBuilt?.(serviceImages);
  }

  const placementNodeId = await resolvePlacement({
    buildDocker: clients.buildDocker,
    policy: "pinned",
    swarmNodeId: target.swarmNodeId,
  });

  injectDeployConfig(doc, {
    builtKeys: Object.keys(serviceImages),
    certResolver: target.certResolver,
    domains: target.domain ? [target.domain] : undefined,
    networkName: target.networkName,
    placementNodeId,
    port: target.port,
    publicService: target.publicService,
    stackName: target.stackName,
  });

  log("▸ Swarm rollout (docker stack deploy)\n");
  return await writeAndDeployStack({
    createDockerApi: clients.createDockerApi,
    doc,
    managerClient: clients.managerClient,
    networkName: target.networkName,
    stackName: target.stackName,
    stream,
  });
}
