import { servers } from "@noddle/db/schema";
import { disconnect } from "@noddle/ssh-executor";
import { restartService } from "@noddle/swarm-ops";
import { eq } from "drizzle-orm";

import type { DeployContext } from "#runtime-context";

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

  const client = await ctx.connectTo(manager);
  try {
    const restarted = await restartService(
      ctx.createDockerApi(client),
      serviceName
    );
    if (!restarted) {
      throw new Error(`no Swarm service named ${serviceName}`);
    }
  } finally {
    disconnect(client);
  }
}
