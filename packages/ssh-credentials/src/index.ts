import { decryptSecret, secretContext } from "@noddle/crypto";
import type { Database } from "@noddle/db";
import { sshKeys } from "@noddle/db/schema";
import type { ServerCredentials } from "@noddle/ssh-executor";
import { eq } from "drizzle-orm";

export interface Reachable {
  host: string;
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
  return credentialsFromKey(appKey, server, key);
}
