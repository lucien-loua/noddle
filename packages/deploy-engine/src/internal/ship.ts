import type { DockerApi, SshClient } from "@noddle/ssh-executor";

import {
  buildImage,
  buildImageFromDockerfile,
  computeBuildCap,
  ensureCappedBuilder,
  fetchSource,
  resolveBuildDir,
} from "./build.ts";
import { serviceRouteLabels } from "./proxy.ts";
import type { DomainRoute } from "./proxy.ts";
import { isPortableImage, pushImage, registryImageTag } from "./registry.ts";
import type { RegistryConfig } from "./registry.ts";
import {
  deployService,
  ensureOverlayNetwork,
  getSwarmNodeId,
  readRunningNodeId,
} from "./swarm.ts";
import type { RegistryAuth, SwarmUpdateState } from "./swarm.ts";

export type PlacementPolicy = "auto" | "pinned" | "portable";

export interface ShipGitSource {
  branch: string;
  commitSha?: string;
  deployKey: string | null;
  keyScope: string;
  repoUrl: string;
  submodules: boolean;
}

export type ShipBuild =
  | { image: string; kind: "image" }
  | {
      buildMethod: "buildpacks" | "dockerfile";
      buildPath?: string;
      kind: "git";
      noCache: boolean;
      publishDirectory?: string;
      repoDir: string;
      source: ShipGitSource;
      totalMemoryMb: number;
    };

export interface ShipTarget {
  certResolver?: string;
  domains: DomainRoute[];
  env: Record<string, string>;
  networkName: string;
  placementPolicy: PlacementPolicy;
  port: number;
  registry: RegistryConfig | undefined;
  serviceName: string;
  swarmNodeId: string | null;
}

export interface ShipClients {
  buildClient: SshClient;
  buildDocker: DockerApi;
  managerDocker: DockerApi;
}

export interface ShipResolvedImage {
  commitSha: string | null;
  imageTag: string;
}

export interface ShipIo {
  onImageResolved?: (image: ShipResolvedImage) => Promise<void> | void;
  onLog?: (line: string) => void;
}

export interface ShipVerdict {
  accepted: boolean;
  commitSha: string | null;
  imageTag: string;
  nodeId: string | null;
  updateMessage: string | null | undefined;
  updateState: SwarmUpdateState | null;
}

function registryAuthFor(
  registry: RegistryConfig | undefined
): RegistryAuth | undefined {
  if (!registry) {
    return;
  }
  return {
    password: registry.password,
    serveraddress: registry.host,
    username: registry.username,
  };
}

async function resolvePlacement(opts: {
  buildDocker: DockerApi;
  image: string;
  policy: PlacementPolicy;
  registry: RegistryConfig | undefined;
  swarmNodeId: string | null;
}): Promise<string | undefined> {
  if (opts.policy === "portable") {
    return;
  }
  if (opts.policy === "auto" && isPortableImage(opts.image, opts.registry)) {
    return;
  }
  return opts.swarmNodeId ?? (await getSwarmNodeId(opts.buildDocker));
}

export async function ship(
  build: ShipBuild,
  target: ShipTarget,
  clients: ShipClients,
  io: ShipIo = {}
): Promise<ShipVerdict> {
  const log = io.onLog ?? (() => undefined);
  const stream = { onStderr: log, onStdout: log };

  let imageTag: string;
  let commitSha: string | null = null;

  if (build.kind === "image") {
    imageTag = build.image;
    log(`▸ image ${imageTag}\n`);
  } else {
    const cap = computeBuildCap({ totalMemoryMb: build.totalMemoryMb });
    log(`▸ build capped at ${cap.memory}\n`);
    await ensureCappedBuilder(clients.buildClient, cap, stream);

    const sha = await fetchSource(clients.buildClient, {
      branch: build.source.branch,
      commitSha: build.source.commitSha,
      deployKey: build.source.deployKey,
      dir: build.repoDir,
      keyScope: build.source.keyScope,
      repoUrl: build.source.repoUrl,
      submodules: build.source.submodules,
      ...stream,
    });
    commitSha = sha;

    const version = `${sha.slice(0, 12)}-${Date.now()}`;
    imageTag = target.registry
      ? registryImageTag(target.registry, target.serviceName, version)
      : `${target.serviceName}:${version}`;
  }

  await io.onImageResolved?.({ commitSha, imageTag });

  if (build.kind === "git") {
    if (build.noCache) {
      log("▸ cache disabled for this build\n");
    }
    const buildDir = resolveBuildDir(build.repoDir, build.buildPath);
    if (build.buildPath) {
      log(`▸ build context: ${build.buildPath}\n`);
    }

    if (build.buildMethod === "dockerfile") {
      log("▸ building from Dockerfile\n");
      await buildImageFromDockerfile(clients.buildClient, {
        contextDir: buildDir,
        dockerfilePath: "Dockerfile",
        imageTag,
        noCache: build.noCache,
        ...stream,
      });
    } else {
      if (build.publishDirectory) {
        log(`▸ static output: ${build.publishDirectory}\n`);
      }
      await buildImage(clients.buildClient, {
        dir: buildDir,
        imageTag,
        noCache: build.noCache,
        publishDirectory: build.publishDirectory,
        ...stream,
      });
    }

    if (target.registry) {
      log("▸ pushing image to the registry\n");
      await pushImage(clients.buildClient, target.registry, {
        imageTag,
        removeLocal: true,
        ...stream,
      });
    }
  }

  const placementNodeId = await resolvePlacement({
    buildDocker: clients.buildDocker,
    image: imageTag,
    policy: target.placementPolicy,
    registry: target.registry,
    swarmNodeId: target.swarmNodeId,
  });

  log("▸ Swarm rollout\n");
  await ensureOverlayNetwork(clients.managerDocker, target.networkName);

  const outcome = await deployService(clients.managerDocker, {
    env: { ...target.env, PORT: String(target.port) },
    image: imageTag,
    labels: serviceRouteLabels({
      certResolver: target.certResolver,
      domains: target.domains,
      port: target.port,
      serviceName: target.serviceName,
    }),
    networkName: target.networkName,
    placementNodeId,
    port: target.port,
    registryAuth: registryAuthFor(target.registry),
    serviceName: target.serviceName,
  });

  return {
    accepted: outcome.accepted,
    commitSha,
    imageTag,
    nodeId: outcome.accepted
      ? await readRunningNodeId(clients.managerDocker, target.serviceName)
      : null,
    updateMessage: outcome.updateMessage,
    updateState: outcome.updateState,
  };
}
