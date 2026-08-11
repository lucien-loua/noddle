import { servers } from "@noddle/db/schema";
import { credentialsFor } from "@noddle/ssh-credentials";
import {
  connect,
  disconnect,
  dockerClient,
  exec,
  execArgv,
} from "@noddle/ssh-executor";
import { eq } from "drizzle-orm";
import { ensureRegistryTrust } from "#registry";
import type { DeployContext } from "#runtime-context";
import { getSwarmNodeId } from "#swarm";

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

    // Idempotent, like install.sh: `docker info` before any `swarm init` or
    // `swarm join` avoids replaying the operation on a node that's already a
    // member. NEVER `... | grep -q` — see CLAUDE.md, the SIGPIPE race under
    // `pipefail` already cost a Phase 0 run.
    const dockerCheck = await exec(client, "command -v docker");
    if (dockerCheck.code !== 0) {
      await exec(client, "curl -fsSL https://get.docker.com | sudo sh");
    }

    // The SSH user MUST belong to the `docker` group: `dockerClient()` opens
    // the socket DIRECTLY, without going through a shell — so no `sudo` is
    // possible on a socket (see the header of @noddle/ssh-executor).
    // `usermod -aG` is idempotent, safe to replay even if already a member.
    //
    // And group membership only applies to a NEW session: the current SSH
    // connection never sees it, whether we just installed Docker or not.
    // Without reconnecting here, the first `dockerClient()` call further
    // down fails with "Channel open failure" — measured on this script,
    // against a genuinely bare VM.
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
      const managerDocker = dockerClient(managerClient);
      // The WORKER token, never the manager's: this node must not be able
      // to create or update a service — `docker service create/update`
      // requires a manager, precisely because only it holds the cluster's
      // replicated state. Staying a worker isn't a limitation we tolerate,
      // it's the guarantee that the Raft quorum size doesn't move when we
      // add a server.
      const swarmInfo = (await managerDocker.swarmInspect()) as {
        JoinTokens?: { Worker?: string };
      };
      const token = swarmInfo.JoinTokens?.Worker;
      if (!token) {
        throw new Error("Swarm join token not found on the manager");
      }

      // `execArgv`, not `exec`: `token` and the manager's host aren't code
      // constants, so the ssh-executor convention applies.
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

    // The registry's CA, without which this node won't be able to PULL any
    // image — and the failure would arrive much later, on the first task
    // Swarm schedules there, in the form of a service that never converges.
    // It's here, at provisioning time, that the node receives everything it
    // needs.
    if (ctx.registry) {
      await ensureRegistryTrust(client, ctx.registry);
    }

    // The same facts as server #1, recorded in Phase 1.
    const docker = dockerClient(client);
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
        // Recorded HERE rather than on every deployment: this is the moment
        // the node just joined the cluster, so the moment this fact comes
        // into being. `deploy.ts` used to read it via an extra `docker info`
        // on every rollout.
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
