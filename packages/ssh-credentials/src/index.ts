import { decryptSecret, secretContext } from "@noddle/crypto";
import type { Database } from "@noddle/db";
import { servers, sshKeys } from "@noddle/db/schema";
import type { ServerCredentials } from "@noddle/ssh-executor";
import { eq } from "drizzle-orm";

export interface Reachable {
  host: string;
  hostKeyFingerprint?: string | null;
  id?: string;
  sshKeyId: string;
  sshPort: number;
  sshUser: string;
}

export function credentialsFromKey(
  appKey: Buffer,
  server: Reachable,
  key: { id: string; privateKeyEncrypted: string }
): ServerCredentials {
  return {
    host: server.host,
    hostKeyFingerprint: server.hostKeyFingerprint ?? null,
    port: server.sshPort,
    privateKey: decryptSecret(
      key.privateKeyEncrypted,
      appKey,
      secretContext.sshKey(key.id)
    ),
    user: server.sshUser,
  };
}

export async function credentialsFor(
  db: Database,
  appKey: Buffer,
  server: Reachable
): Promise<ServerCredentials> {
  const key = await db.query.sshKeys.findFirst({
    where: eq(sshKeys.id, server.sshKeyId),
  });
  if (!key) {
    throw new Error(`SSH key ${server.sshKeyId} not found`);
  }
  const creds = credentialsFromKey(appKey, server, key);
  if (server.id && !creds.hostKeyFingerprint) {
    creds.onHostKey = (fingerprint) => {
      db.update(servers)
        .set({ hostKeyFingerprint: fingerprint })
        .where(eq(servers.id, server.id as string))
        .catch(() => undefined);
    };
  }
  return creds;
}
