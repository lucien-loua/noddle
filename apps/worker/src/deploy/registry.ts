import { readFileSync } from "node:fs";

import { decryptSecret, secretContext } from "@noddle/crypto";
import type { Database } from "@noddle/db";
import { registries, servers } from "@noddle/db/schema";
import { ensureRegistryTrust, REGISTRY_USER } from "@noddle/registry";
import type { RegistryConfig } from "@noddle/registry";
import { disconnect, dockerClient } from "@noddle/ssh-executor";
import type { DockerApi, SshClient } from "@noddle/ssh-executor";
import { getSwarmNodeId } from "@noddle/swarm-ops";
import { eq } from "drizzle-orm";

type ServerRow = typeof servers.$inferSelect;

/** Path to the CA in the worker container, mounted by the control plane's stack. */
const CA_PATH = "/etc/noddle/registry/ca.crt";

/**
 * Reads the registry configuration from the environment, or returns
 * `undefined`.
 *
 * `undefined` is not an error: it's the behavior from BEFORE the registry —
 * local build, service pinned to its node — and that's what makes updating
 * an existing installation safe. New code on a stack that hasn't restarted
 * yet behaves exactly like the old one.
 */
export function loadRegistryConfig(): RegistryConfig | undefined {
  const host = process.env.REGISTRY_HOST;
  const password = process.env.REGISTRY_PASSWORD;
  if (!(host && password)) {
    return;
  }
  let caCert: string;
  try {
    caCert = readFileSync(CA_PATH, "utf-8");
  } catch (error) {
    // No silent fallback to local mode here: REGISTRY_HOST is present, so
    // the installation BELIEVES it has a registry. Starting anyway would
    // produce pinned deployments nobody asked for, and the bug wouldn't show
    // up until the day a node goes down.
    //
    // The cause is passed through as-is: "file missing" and "permission
    // denied" call for two different fixes, and the second one happens if
    // the mount was made on the directory instead of just the certificate.
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `REGISTRY_HOST is set but the CA is unreadable (${CA_PATH}) — did the installer run? ${detail}`,
      { cause: error },
    );
  }
  return { caCert, host, password, username: REGISTRY_USER };
}

/**
 * A service's registry: its own if it chose one, the installation's
 * otherwise.
 *
 * `null` doesn't mean "no registry" but "whichever there is" — the same
 * shape as `databases.s3_destination_id`. An installation without an
 * external registry is therefore never asked the question, and the previous
 * behavior is exactly preserved.
 *
 * The password is decrypted HERE and nowhere else: it's the only place in
 * the worker that needs it, and it must not travel through more layers than
 * necessary.
 */
export async function resolveRegistry(opts: {
  appKey: Buffer;
  db: Database;
  embedded: RegistryConfig | undefined;
  registryId: string | null;
}): Promise<RegistryConfig | undefined> {
  if (!opts.registryId) {
    return opts.embedded;
  }
  const row = await opts.db.query.registries.findFirst({
    where: eq(registries.id, opts.registryId),
  });
  if (!row) {
    // The foreign key is `restrict`, so this shouldn't happen. We say so
    // anyway rather than silently falling back to the embedded registry:
    // pushing somewhere other than where the user asked is the kind of
    // discrepancy that would only be discovered while searching for the
    // image.
    throw new Error(`registry ${opts.registryId} no longer exists`);
  }
  return {
    host: row.registryUrl,
    imagePrefix: row.imagePrefix || undefined,
    password: decryptSecret(row.passwordEncrypted, opts.appKey, secretContext.registry(row.id)),
    username: row.username,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Trust
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Passes over every `connected` server and makes sure it trusts the
 * registry — and that we know its Swarm node ID.
 *
 * A SWEEP, not a one-time action at startup. Two reasons:
 *
 *   - MIGRATION. Servers already provisioned were provisioned before the
 *     registry existed; nobody will go back through `provisionServer` for
 *     them. Without this sweep, they'd stay unable to pull an image, and
 *     the bug wouldn't show up until the first task Swarm schedules there.
 *   - a server unreachable at worker startup must not stay excluded
 *     forever. It becomes reachable again, and the next sweep catches up.
 *
 * Same shape as `sweepWatch`/`sweepBackups`/`collectMetrics`, and for the
 * same reason: the state lives in Postgres, a flushed Redis makes nothing
 * disappear.
 *
 * An unreachable server is SKIPPED, never marked as failed: this sweep isn't
 * an availability probe, and overwriting `lastError` with its own error
 * would mask the real cause already recorded by provisioning.
 */
export async function sweepRegistryTrust(opts: {
  /**
   * Injected rather than imported from `#runtime-context`: that module is
   * the SSH session seam; injecting keeps registry free of a hard cycle
   * when callers already hold a live connection factory.
   * one in order to push, and the cycle would be real — TYPE imports vanish
   * at compile time, function imports don't.
   */
  connectTo: (server: ServerRow) => Promise<SshClient>;
  createDockerApi?: (client: SshClient) => DockerApi;
  db: Database;
  registry?: RegistryConfig;
}): Promise<{ skipped: number; trusted: number }> {
  const result = { skipped: 0, trusted: 0 };
  const { registry } = opts;
  const createDockerApi = opts.createDockerApi ?? dockerClient;
  if (!registry) {
    return result;
  }

  const connected = await opts.db.query.servers.findMany({
    where: eq(servers.status, "connected"),
  });

  for (const server of connected) {
    let client: SshClient | undefined;
    try {
      // One SSH session per machine, opened and closed one after another.
      // Parallelizing them would open N simultaneous connections from a 2GB
      // machine, for work that only writes a 2KB file.
      // biome-ignore lint/performance/noAwaitInLoops: deliberately sequential
      client = await opts.connectTo(server);
      const written = await ensureRegistryTrust(client, registry);
      if (written) {
        result.trusted += 1;
      }
      if (!server.swarmNodeId) {
        // Catches up servers provisioned before the column existed.
        const nodeId = await getSwarmNodeId(createDockerApi(client));
        await opts.db.update(servers).set({ swarmNodeId: nodeId }).where(eq(servers.id, server.id));
      }
    } catch {
      result.skipped += 1;
    } finally {
      if (client) {
        disconnect(client);
      }
    }
  }
  return result;
}
