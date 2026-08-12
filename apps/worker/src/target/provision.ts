import { servers } from "@noddle/db/schema";
import { ensureRegistryTrust } from "@noddle/registry";
import { credentialsFor } from "@noddle/ssh-credentials";
import { connect, disconnect, exec, execArgv } from "@noddle/ssh-executor";
import { getSwarmNodeId } from "@noddle/swarm-ops";
import { eq } from "drizzle-orm";
import type { DeployContext } from "#runtime-context";

async function connectAsRow(
  ctx: DeployContext,
  row: typeof servers.$inferSelect
) {
  return await connect(await credentialsFor(ctx.db, ctx.appKey, row));
}

async function markFailed(
  ctx: DeployContext,
  serverId: string,
  message: string
): Promise<void> {
  await ctx.db
    .update(servers)
    .set({ lastError: message, status: "unreachable" })
    .where(eq(servers.id, serverId));
}

export async function provisionServer(
  ctx: DeployContext,
  serverId: string
): Promise<void> {
  const server = await ctx.db.query.servers.findFirst({
    where: eq(servers.id, serverId),
  });
  if (!server) {
    throw new Error(`server not found: ${serverId}`);
  }

  const manager = await ctx.db.query.servers.findFirst({
    where: eq(servers.role, "manager"),
  });
  if (!manager) {
    await markFailed(
      ctx,
      serverId,
      "no Swarm manager registered — has the installer run?"
    );
    throw new Error("no Swarm manager registered");
  }

  let client: Awaited<ReturnType<typeof connect>> | undefined;
  let managerClient: Awaited<ReturnType<typeof connect>> | undefined;

  try {
    client = await connectAsRow(ctx, server);

    const dockerCheck = await exec(client, "command -v docker");
    if (dockerCheck.code !== 0) {
      await exec(client, "curl -fsSL https://get.docker.com | sudo sh");
    }

    await execArgv(client, [
      "sudo",
      "usermod",
      "-aG",
      "docker",
      server.sshUser,
    ]);
    disconnect(client);
    client = await connectAsRow(ctx, server);

    const swarmState = await exec(
      client,
      "sudo docker info --format '{{.Swarm.LocalNodeState}}'"
    );

    if (swarmState.stdout.trim() !== "active") {
      managerClient = await connectAsRow(ctx, manager);
      const managerDocker = ctx.createDockerApi(managerClient);

      const swarmInfo = (await managerDocker.swarmInspect()) as {
        JoinTokens?: { Worker?: string };
      };
      const token = swarmInfo.JoinTokens?.Worker;
      if (!token) {
        throw new Error("Swarm join token not found on the manager");
      }

      const join = await execArgv(client, [
        "sudo",
        "docker",
        "swarm",
        "join",
        "--token",
        token,
        `${manager.host}:2377`,
      ]);
      if (join.code !== 0) {
        throw new Error(
          `could not join the Swarm cluster: ${join.stderr.trim() || join.stdout.trim()}`
        );
      }
    }

    const nixpacksCheck = await exec(client, "command -v nixpacks");
    if (nixpacksCheck.code !== 0) {
      await exec(
        client,
        "curl -sSL https://nixpacks.com/install.sh | sudo bash"
      );
    }

    if (ctx.registry) {
      await ensureRegistryTrust(client, ctx.registry);
    }

    const docker = ctx.createDockerApi(client);
    const info = (await docker.info()) as { MemTotal?: number };
    const version = (await docker.version()) as {
      MinAPIVersion?: string;
      Version?: string;
    };

    await ctx.db
      .update(servers)
      .set({
        dockerApiMinVersion: version.MinAPIVersion ?? null,
        dockerVersion: version.Version ?? null,
        lastError: null,
        status: "connected",
        swarmNodeId: await getSwarmNodeId(docker),
        totalMemoryMb: info.MemTotal
          ? Math.round(info.MemTotal / 1024 / 1024)
          : null,
      })
      .where(eq(servers.id, server.id));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markFailed(ctx, serverId, message);
    throw err;
  } finally {
    if (managerClient) {
      disconnect(managerClient);
    }
    if (client) {
      disconnect(client);
    }
  }
}
