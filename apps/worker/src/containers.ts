import { servers } from "@noddle/db/schema";
import { disconnect, dockerClient } from "@noddle/ssh-executor";
import { eq } from "drizzle-orm";
import { connectTo, type DeployContext } from "#runtime-context";
import { restartService } from "#swarm";

/**
 * Restarts the Swarm service carrying this name.
 *
 * On the MANAGER, always: only it holds the cluster's replicated state, a
 * worker refuses a service update. Found by `role`, never by `isSelf`, a
 * decision already settled.
 *
 * Throws if the service disappeared between the page rendering and the
 * click — which happens, a task can be the last one of a service that was
 * just removed. Better to say so than to claim to have restarted something
 * that no longer exists.
 */
export async function restartSwarmServiceByName(
  ctx: DeployContext,
  serviceName: string
): Promise<void> {
  const manager = await ctx.db.query.servers.findFirst({
    where: eq(servers.role, "manager"),
  });
  if (!manager) {
    throw new Error("no Swarm manager registered");
  }

  const client = await connectTo(ctx, manager);
  try {
    const restarted = await restartService(dockerClient(client), serviceName);
    if (!restarted) {
      throw new Error(`no Swarm service named ${serviceName}`);
    }
  } finally {
    disconnect(client);
  }
}
