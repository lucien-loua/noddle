import type { Database } from "@noddle/db";
import { servers } from "@noddle/db/schema";
import type { RegistryConfig } from "@noddle/deploy-engine";
import { credentialsFor } from "@noddle/ssh-credentials";
import { connect, dockerClient } from "@noddle/ssh-executor";
import type { DockerApi, SshClient } from "@noddle/ssh-executor";
import { eq } from "drizzle-orm";

export type ServerRow = typeof servers.$inferSelect;

export interface ConnectForDeployResult {
  buildClient: SshClient;
  managerClient: SshClient;
  sameConnection: boolean;
}

export interface DeployConnectors {
  connectForDeploy: (server: ServerRow) => Promise<ConnectForDeployResult>;
  connectTo: (server: ServerRow) => Promise<SshClient>;
  createDockerApi: (client: SshClient) => DockerApi;
}

export interface DeployContext extends DeployConnectors {
  appKey: Buffer;
  db: Database;
  registry?: RegistryConfig;
}

type DeployCore = Pick<DeployContext, "appKey" | "db" | "registry">;

function defaultConnectTo(
  core: Pick<DeployContext, "appKey" | "db">
): DeployContext["connectTo"] {
  return async (server) =>
    connect(await credentialsFor(core.db, core.appKey, server));
}

function defaultConnectForDeploy(
  core: Pick<DeployContext, "db">,
  connectToFn: DeployContext["connectTo"]
): DeployContext["connectForDeploy"] {
  return async (server) => {
    const manager = await core.db.query.servers.findFirst({
      where: eq(servers.role, "manager"),
    });
    if (!manager) {
      throw new Error(
        "no Swarm manager registered: the installer should have created one"
      );
    }

    const buildClient = await connectToFn(server);
    if (manager.id === server.id) {
      return { buildClient, managerClient: buildClient, sameConnection: true };
    }
    const managerClient = await connectToFn(manager);
    return { buildClient, managerClient, sameConnection: false };
  };
}

export interface CreateDeployContextOverrides {
  connectForDeploy?: DeployContext["connectForDeploy"];
  connectTo?: DeployContext["connectTo"];
  createDockerApi?: DeployContext["createDockerApi"];
}

export function createDeployContext(
  core: DeployCore,
  overrides?: CreateDeployContextOverrides
): DeployContext {
  const connectToFn = overrides?.connectTo ?? defaultConnectTo(core);
  return {
    ...core,
    connectForDeploy:
      overrides?.connectForDeploy ?? defaultConnectForDeploy(core, connectToFn),
    connectTo: connectToFn,
    createDockerApi: overrides?.createDockerApi ?? dockerClient,
  };
}

export interface RouteOptions {
  certResolver?: string;
  networkName: string;
}

export interface BuildOptions {
  logRoot: string;
  onLog?: (deploymentId: string, chunk: string) => void;
}

export interface WorkerDeps {
  build: BuildOptions;
  ctx: DeployContext;
  route: RouteOptions;
}

export const BUILD_ROOT = "/var/lib/noddle/builds";
