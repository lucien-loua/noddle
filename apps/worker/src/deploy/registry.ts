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

const CA_PATH = "/etc/noddle/registry/ca.crt";

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
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `REGISTRY_HOST is set but the CA is unreadable (${CA_PATH}). Did the installer run? ${detail}`,
      { cause: error }
    );
  }
  return { caCert, host, password, username: REGISTRY_USER };
}

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
    throw new Error(`registry ${opts.registryId} no longer exists`);
  }
  return {
    host: row.registryUrl,
    imagePrefix: row.imagePrefix || undefined,
    password: decryptSecret(
      row.passwordEncrypted,
      opts.appKey,
      secretContext.registry(row.id)
    ),
    username: row.username,
  };
}

export async function sweepRegistryTrust(opts: {
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
      client = await opts.connectTo(server);
      const written = await ensureRegistryTrust(client, registry);
      if (written) {
        result.trusted += 1;
      }
      if (!server.swarmNodeId) {
        const nodeId = await getSwarmNodeId(createDockerApi(client));
        await opts.db
          .update(servers)
          .set({ swarmNodeId: nodeId })
          .where(eq(servers.id, server.id));
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
