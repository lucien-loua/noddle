import { servers, sshKeys } from "@noddle/db/schema";
import { decryptSecret, secretContext } from "@noddle/shared/crypto";
import { connect, type SshClient } from "@noddle/ssh-executor";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db.server";
import { env } from "@/lib/env.server";

type ServerRow = typeof servers.$inferSelect;

/**
 * A session to THIS machine, with the key read from the library.
 *
 * Factored out rather than copied: it's the same lesson as
 * `credentialsFor` on the worker side, where `deploy.ts`, `sweep.ts` and
 * `provision.ts` each kept a copy — three chances to let one go stale.
 */
export async function connectToServer(server: ServerRow): Promise<SshClient> {
  const key = await db.query.sshKeys.findFirst({
    where: eq(sshKeys.id, server.sshKeyId),
  });
  if (!key) {
    throw new Error(`SSH key ${server.sshKeyId} not found`);
  }
  return await connect({
    host: server.host,
    port: server.sshPort,
    privateKey: decryptSecret(
      key.privateKeyEncrypted,
      env.appKey,
      secretContext.sshKey(key.id)
    ),
    user: server.sshUser,
  });
}

/**
 * A session to the Swarm manager.
 *
 * Found by `role` and never by `isSelf` — an already-settled decision:
 * `isSelf` stays display-only.
 */
export async function connectToManager(): Promise<SshClient> {
  const manager = await db.query.servers.findFirst({
    where: eq(servers.role, "manager"),
  });
  if (!manager) {
    throw new Error("no Swarm manager registered");
  }
  return await connectToServer(manager);
}
