import { servers } from "@noddle/db/schema";
import { credentialsFor } from "@noddle/ssh-credentials";
import { connect, disconnect } from "@noddle/ssh-executor";
import type { SshClient } from "@noddle/ssh-executor";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db.server";
import { env } from "@/lib/env.server";

type ServerRow = typeof servers.$inferSelect;

export async function connectToServer(server: ServerRow): Promise<SshClient> {
  return await connect(await credentialsFor(db, env.appKey, server));
}

export async function connectToManager(): Promise<SshClient> {
  const manager = await db.query.servers.findFirst({
    where: eq(servers.role, "manager"),
  });
  if (!manager) {
    throw new Error("no Swarm manager registered");
  }
  return await connectToServer(manager);
}

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
