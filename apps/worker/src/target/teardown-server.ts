import { databases, servers, services, stacks } from "@noddle/db/schema";
import { disconnect, execArgv } from "@noddle/ssh-executor";
import { eq } from "drizzle-orm";

import type { DeployContext } from "#runtime-context";

export async function serverRemovalBlocker(
  ctx: DeployContext,
  serverId: string
): Promise<string | null> {
  const server = await ctx.db.query.servers.findFirst({
    where: eq(servers.id, serverId),
  });
  if (!server) {
    return "server not found";
  }
  if (server.role === "manager") {
    return "this is the Swarm manager: removing it would leave the installation unable to deploy anything";
  }

  const [svc, stk, dbs] = await Promise.all([
    ctx.db.query.services.findMany({ where: eq(services.serverId, serverId) }),
    ctx.db.query.stacks.findMany({ where: eq(stacks.serverId, serverId) }),
    ctx.db.query.databases.findMany({
      where: eq(databases.serverId, serverId),
    }),
  ]);

  const held = [
    svc.length ? `${svc.length} service(s)` : "",
    stk.length ? `${stk.length} stack(s)` : "",
    dbs.length ? `${dbs.length} database(s)` : "",
  ].filter(Boolean);

  if (held.length > 0) {
    return `still hosts ${held.join(", ")}: move or delete them first`;
  }
  return null;
}

export async function runServerTeardown(
  ctx: DeployContext,
  serverId: string
): Promise<void> {
  const blocker = await serverRemovalBlocker(ctx, serverId);
  if (blocker) {
    throw new Error(blocker);
  }

  const server = await ctx.db.query.servers.findFirst({
    where: eq(servers.id, serverId),
  });
  if (!server) {
    return;
  }

  const manager = await ctx.db.query.servers.findFirst({
    where: eq(servers.role, "manager"),
  });

  try {
    const client = await ctx.connectTo(server);
    try {
      await execArgv(client, ["sudo", "docker", "swarm", "leave", "--force"]);
    } finally {
      disconnect(client);
    }
  } catch {}

  if (manager && server.swarmNodeId) {
    try {
      const client = await ctx.connectTo(manager);
      try {
        await execArgv(client, [
          "sudo",
          "docker",
          "node",
          "rm",
          "--force",
          server.swarmNodeId,
        ]);
      } finally {
        disconnect(client);
      }
    } catch {}
  }

  await ctx.db.delete(servers).where(eq(servers.id, serverId));
}
