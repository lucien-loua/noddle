import { sshKeys } from "@noddle/db/schema";
import { decryptSecret, secretContext } from "@noddle/shared/crypto";
import type { ServerCredentials } from "@noddle/ssh-executor";
import { eq } from "drizzle-orm";
import type { DeployContext } from "#deploy";

/** What's needed of a server to reach it. Deliberately narrower than the
 *  whole row: this module doesn't need to know the Swarm status. */
interface Reachable {
  host: string;
  sshKeyId: string;
  sshPort: number;
  sshUser: string;
}

/**
 * A server's connection credentials.
 *
 * Throws if the key has disappeared. That's the correct behavior: the
 * foreign key constraint is `restrict`, so a missing key can only come from
 * a tampered-with database — and connecting "without a key" doesn't exist.
 */
export async function credentialsFor(
  ctx: Pick<DeployContext, "appKey" | "db">,
  server: Reachable
): Promise<ServerCredentials> {
  const key = await ctx.db.query.sshKeys.findFirst({
    where: eq(sshKeys.id, server.sshKeyId),
  });
  if (!key) {
    throw new Error(`SSH key ${server.sshKeyId} not found`);
  }
  return {
    host: server.host,
    port: server.sshPort,
    privateKey: decryptSecret(
      key.privateKeyEncrypted,
      ctx.appKey,
      secretContext.sshKey(key.id)
    ),
    user: server.sshUser,
  };
}
