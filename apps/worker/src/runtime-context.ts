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
import { connect } from "@noddle/ssh-executor";
import { eq } from "drizzle-orm";

export type ServerRow = typeof servers.$inferSelect;

/**
 * What every job needs: the database, the key that opens secrets, and the
 * registry when the installation has one.
 *
 * These three are shared because they genuinely are — `db` by all 19
 * modules, `appKey` by the 9 that decrypt something, `registry` by the 5
 * that place or purge an image. The four ship-only fields that used to sit
 * here moved to {@link RouteOptions} and {@link BuildOptions}: they were
 * read by three modules and visible to nineteen.
 */
export interface DeployContext {
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

/** Opens an SSH connection to a server, key read from the library. */
export async function connectTo(
  ctx: DeployContext,
  server: ServerRow
): ReturnType<typeof connect> {
  return await connect(await credentialsFor(ctx.db, ctx.appKey, server));
}

/**
 * Two distinct connections: build on the service's server, Swarm commands on
 * the manager — found by `role`, not by `isSelf`. The machine hosting Noddle
 * is display-only by settled decision, never a code branch; `role` is the
 * field that carries the orchestration fact, even though in Phase 2 the two
 * columns always point to the same row — because only one machine ran
 * `docker swarm init`, never because one is derived from the other.
 *
 * Reuses the SAME connection when the two coincide (the single-server case),
 * so as not to open a needless SSH session to a machine we've already just
 * reached.
 */
export async function connectForDeploy(
  ctx: DeployContext,
  server: ServerRow
): Promise<{
  buildClient: Awaited<ReturnType<typeof connect>>;
  managerClient: Awaited<ReturnType<typeof connect>>;
  sameConnection: boolean;
}> {
  const manager = await ctx.db.query.servers.findFirst({
    where: eq(servers.role, "manager"),
  });
  if (!manager) {
    throw new Error(
      "no Swarm manager registered — the installer should have created one"
    );
  }

  const buildClient = await connectTo(ctx, server);
  if (manager.id === server.id) {
    return { buildClient, managerClient: buildClient, sameConnection: true };
  }
  const managerClient = await connectTo(ctx, manager);
  return { buildClient, managerClient, sameConnection: false };
}
