import { decryptSecret, secretContext } from "@noddle/crypto";
import type { Database } from "@noddle/db";
import { sshKeys } from "@noddle/db/schema";
import type { ServerCredentials } from "@noddle/ssh-executor";
import { eq } from "drizzle-orm";

/**
 * What's needed of a server to reach it. Deliberately narrower than the
 * whole row: credentials don't care about Swarm status or display name.
 */
export interface Reachable {
  host: string;
  sshKeyId: string;
  sshPort: number;
  sshUser: string;
}

/**
 * Pure half of the SSH key library: encrypted row + reachable host →
 * transport credentials.
 *
 * Lookup lives in {@link credentialsFor}. Keeping decrypt+map here means
 * web and worker can't drift on AAD or field mapping without failing the
 * same unit suite.
 */
export function credentialsFromKey(
  appKey: Buffer,
  server: Reachable,
  key: { id: string; privateKeyEncrypted: string },
): ServerCredentials {
  return {
    host: server.host,
    port: server.sshPort,
    privateKey: decryptSecret(key.privateKeyEncrypted, appKey, secretContext.sshKey(key.id)),
    user: server.sshUser,
  };
}

/**
 * A server's connection credentials from the SSH key library.
 *
 * Throws if the key has disappeared. That's the correct behavior: the
 * foreign key constraint is `restrict`, so a missing key can only come from
 * a tampered-with database — and connecting "without a key" doesn't exist.
 */
export async function credentialsFor(
  db: Database,
  appKey: Buffer,
  server: Reachable,
): Promise<ServerCredentials> {
  const key = await db.query.sshKeys.findFirst({
    where: eq(sshKeys.id, server.sshKeyId),
  });
  if (!key) {
    throw new Error(`SSH key ${server.sshKeyId} not found`);
  }
  return credentialsFromKey(appKey, server, key);
}
