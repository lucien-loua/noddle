import { servers } from "@noddle/db/schema";
import { credentialsFor } from "@noddle/ssh-credentials";
import { connect, type SshClient } from "@noddle/ssh-executor";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db.server";
import { env } from "@/lib/env.server";

type ServerRow = typeof servers.$inferSelect;

/**
 * A session to THIS machine, with the key read from the library.
 *
 * Credentials come from `@noddle/ssh-credentials` — the same module the
 * worker uses — so decrypt AAD and field mapping cannot drift.
 */
export async function connectToServer(server: ServerRow): Promise<SshClient> {
  return await connect(await credentialsFor(db, env.appKey, server));
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
