import { databases, servers, services, stacks } from "@noddle/db/schema";
import { disconnect, execArgv } from "@noddle/ssh-executor";
import { eq } from "drizzle-orm";

import type { DeployContext } from "#runtime-context";

/** What blocks a removal, in plain language. `null` = nothing stands in the way. */
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

/**
 * Make the node leave the cluster, then remove its row.
 *
 * BOTH SIDES, and order matters. The node leaves itself (`swarm leave`),
 * which makes it `Down` from the manager's point of view; the manager can
 * then remove it from its list. The reverse — `node rm` first — would leave
 * a daemon that still believes it's in a cluster and would keep trying to
 * reattach.
 *
 * Neither step is blocking: a powered-off or already-departed server must
 * not prevent removing its row, otherwise a dead machine would stay on the
 * dashboard forever — exactly the kind of screen that lies. The goal is
 * that the row goes; the cluster is just tidy-up.
 */
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

  // ── 1. the node leaves the cluster, best-effort ────────────────────────
  try {
    const client = await ctx.connectTo(server);
    try {
      await execArgv(client, ["sudo", "docker", "swarm", "leave", "--force"]);
    } finally {
      disconnect(client);
    }
  } catch {
    // Machine unreachable: continue. The manager will see it `Down` and
    // the next step will remove it anyway.
  }

  // ── 2. the manager forgets the node, best-effort ───────────────────────
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
    } catch {
      // The node will stay listed on the Docker side, which can be fixed by
      // hand. The row, though, must go: that's what the screen shows.
    }
  }

  // ── 3. the row ─────────────────────────────────────────────────────────
  // `server_metrics` goes in cascade. Nothing else points at a server
  // without `restrict`, and the three that do have already been verified empty.
  await ctx.db.delete(servers).where(eq(servers.id, serverId));
}
