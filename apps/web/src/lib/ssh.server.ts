import { servers } from "@noddle/db/schema";
import { credentialsFor } from "@noddle/ssh-credentials";
import { connect, disconnect } from "@noddle/ssh-executor";
import type { SshClient } from "@noddle/ssh-executor";
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

/** Open one SSH session, run `fn`, always disconnect — web-side twin of worker `withDeployClients`. */
export async function withServerSession<T>(
  server: ServerRow,
  fn: (client: SshClient) => Promise<T>
): Promise<T> {
  const client = await connectToServer(server);
  try {
    return await fn(client);
  } finally {
    disconnect(client);
  }
}

/** Manager session with the same teardown guarantee as `withServerSession`. */
export async function withManagerSession<T>(
  fn: (client: SshClient) => Promise<T>
): Promise<T> {
  const client = await connectToManager();
  try {
    return await fn(client);
  } finally {
    disconnect(client);
  }
}

/** Open a session by row id — for handlers that only know `serverId`. */
export async function withServerSessionById<T>(
  serverId: string,
  fn: (client: SshClient) => Promise<T>
): Promise<T> {
  const server = await db.query.servers.findFirst({
    where: eq(servers.id, serverId),
  });
  if (!server) {
    throw new Error("server not found");
  }
  return withServerSession(server, fn);
}
