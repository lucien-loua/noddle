/**
 * Worker runtime session: DB + APP_KEY + SSH helpers.
 *
 * Kept out of `#deploy` so opening a session does not pull the ship/rollback
 * pipeline (build-engine, swarm labels, watch). Jobs that only need SSH or
 * context import this module.
 */
import type { Database } from "@noddle/db";
import { servers } from "@noddle/db/schema";
import type { RegistryConfig } from "@noddle/registry";
import { credentialsFor } from "@noddle/ssh-credentials";
import { connect, dockerClient } from '@noddle/ssh-executor';
import type { DockerApi, SshClient } from '@noddle/ssh-executor';
import { eq } from "drizzle-orm";

export type ServerRow = typeof servers.$inferSelect;

export interface ConnectForDeployResult {
  buildClient: SshClient;
  managerClient: SshClient;
  sameConnection: boolean;
}

/**
 * Injected connection factories — the ports & adapters seam (architecture
 * review C4). Production uses SSH + dockerode; tests swap in-memory Docker.
 */
export interface DeployConnectors {
  /** Build node + Swarm manager pair for deploy/database paths. */
  connectForDeploy: (server: ServerRow) => Promise<ConnectForDeployResult>;
  /** Opens one SSH session to a server. */
  connectTo: (server: ServerRow) => Promise<SshClient>;
  /** Wraps an SSH session as a remote Docker API. Override in tests. */
  createDockerApi: (client: SshClient) => DockerApi;
}

/**
 * What every job needs: the database, the key that opens secrets, and the
 * registry when the installation has one.
 *
 * Connection factories live on the context so orchestration (status
 * transitions, notify fan-out) can be tested without a VM — the same pattern
 * as `sweepRegistryTrust` taking `connectTo` as a parameter.
 */
export interface DeployContext extends DeployConnectors {
  appKey: Buffer;
  db: Database;
  /**
   * This installation's image registry, or `undefined`.
   *
   * `undefined` isn't a failure: it's the behavior from before the registry
   * existed — local build, image that only exists on its node, service
   * pinned there by a placement constraint. An updated installation whose
   * stack hasn't restarted yet goes through exactly this path, and behaves
   * as before.
   */
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
        "no Swarm manager registered — the installer should have created one"
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

/** Wires production SSH/dockerode adapters unless overrides are passed. */
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

/**
 * Where a service is reachable from — needed by anything that writes Traefik
 * labels or attaches the overlay network.
 *
 * Carried by both the ship paths and the rollback paths, and by the
 * post-deploy watch, which redeploys a previous image on its own (ADR-0012).
 */
export interface RouteOptions {
  /**
   * Traefik's ACME resolver, when the installation has one. Absent =
   * deployed applications go out over plain HTTP, which remains the case
   * for a machine without a domain — a certificate can only be obtained for
   * a name.
   */
  certResolver?: string;
  /** Overlay network shared with Traefik. */
  networkName: string;
}

/**
 * Where build output goes. Only the two paths that actually BUILD take this.
 *
 * A rollback redeploys an image that already exists, so it has no build to
 * log — and with no parameter to put one in, nobody can wire a build log
 * into it by mistake.
 */
export interface BuildOptions {
  /** Root of build logs on the control plane. */
  logRoot: string;
  /** Feeds the dashboard's SSE stream. */
  onLog?: (deploymentId: string, chunk: string) => void;
}

/** What the host hands to every job handler. */
export interface WorkerDeps {
  build: BuildOptions;
  ctx: DeployContext;
  route: RouteOptions;
}

/**
 * Where repositories are cloned and built, on the TARGET server.
 *
 * Not `/opt/noddle`, which is Noddle's own installation. The distinction
 * only matters on the self-hosted machine — i.e. the common case, and the
 * machine we can least afford to damage: `fetchSource` starts with an
 * `rm -rf` of this directory, and having it live inside the control plane's
 * git repo would put the one thing that can't be rebuilt within reach of a
 * malformed identifier.
 *
 * `/var/lib/noddle` follows the convention already set by `LOG_ROOT`.
 */
export const BUILD_ROOT = "/var/lib/noddle/builds";
