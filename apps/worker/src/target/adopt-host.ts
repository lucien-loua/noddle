import { readFileSync } from "node:fs";

import { encryptSecret, loadAppKey, secretContext } from "@noddle/crypto";
import { createDatabase } from "@noddle/db";
import { servers, sshKeys } from "@noddle/db/schema";
import { getSwarmNodeId } from "@noddle/deploy-engine";
import { ensureRegistryTrust } from "@noddle/deploy-engine/ops";
import { connect, disconnect, dockerClient } from "@noddle/ssh-executor";
import { publicKeyOf } from "@noddle/ssh-executor/keys";
import { and, eq } from "drizzle-orm";

import { loadRegistryConfig } from "#registry";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`required environment variable: ${name}`);
  }
  return value;
}

const db = createDatabase({ url: required("DATABASE_URL") });
const appKey = loadAppKey(process.env.APP_KEY);

const host = required("HOST_IP");
const user = required("HOST_USER");
const port = Number(process.env.HOST_SSH_PORT ?? 22);
const privateKey = readFileSync(required("HOST_SSH_KEY"), "utf-8");
const registry = loadRegistryConfig();

async function recordReachability(serverId: string): Promise<void> {
  let client: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    client = await connect({ host, port, privateKey, user });

    if (registry) {
      await ensureRegistryTrust(client, registry);
      process.stdout.write(`  registry credentials saved (${registry.host})\n`);
    }

    const docker = dockerClient(client);
    const info = (await docker.info()) as { MemTotal?: number };
    const version = (await docker.version()) as {
      MinAPIVersion?: string;
      Version?: string;
    };
    await db
      .update(servers)
      .set({
        dockerApiMinVersion: version.MinAPIVersion ?? null,
        dockerVersion: version.Version ?? null,
        lastError: null,
        status: "connected",
        swarmNodeId: await getSwarmNodeId(docker),
        totalMemoryMb: info.MemTotal
          ? Math.round(info.MemTotal / 1024 / 1024)
          : null,
      })
      .where(eq(servers.id, serverId));
    process.stdout.write(`  reachable: Docker ${version.Version ?? "?"}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db
      .update(servers)
      .set({ lastError: message, status: "unreachable" })
      .where(eq(servers.id, serverId));
    process.stdout.write(`  unreachable: ${message}\n`);
  } finally {
    if (client) {
      disconnect(client);
    }
  }
}

const existing = await db.query.servers.findFirst({
  where: and(
    eq(servers.host, host),
    eq(servers.sshPort, port),
    eq(servers.sshUser, user)
  ),
});

async function seedInstallerKey(): Promise<string> {
  const name = "Noddle host";
  const found = await db.query.sshKeys.findFirst({
    where: eq(sshKeys.name, name),
  });
  const id = found?.id ?? crypto.randomUUID();
  const values = {
    id,
    name,
    privateKeyEncrypted: encryptSecret(
      privateKey,
      appKey,
      secretContext.sshKey(id)
    ),
    publicKey: publicKeyOf(privateKey),
  };

  if (found) {
    await db.update(sshKeys).set(values).where(eq(sshKeys.id, id));
  } else {
    await db.insert(sshKeys).values(values);
  }
  return id;
}

const sshKeyId = await seedInstallerKey();

if (existing) {
  await db
    .update(servers)
    .set({ isSelf: true, role: "manager", sshKeyId })
    .where(eq(servers.id, existing.id));
  process.stdout.write(`server #1 already registered (${existing.id})\n`);
  await recordReachability(existing.id);
} else {
  const [created] = await db
    .insert(servers)
    .values({
      host,
      isSelf: true,
      name: process.env.HOST_NAME ?? "this machine",
      role: "manager",
      sshKeyId,
      sshPort: port,
      sshUser: user,
    })
    .returning();
  if (!created) {
    throw new Error("could not register the server");
  }
  process.stdout.write(`server #1 registered (${created.id})\n`);
  await recordReachability(created.id);
}

process.exit(0);
