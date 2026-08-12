/**
 * Owns the SSH connection pair for a worker job: open, hand over, close
 * once — in one order. Call sites used to copy four divergent `finally`
 * blocks; this is the single teardown.
 */
import type { servers } from "@noddle/db/schema";
import {
  type DockerApi,
  disconnect,
  type SshClient,
} from "@noddle/ssh-executor";
import type { DeployContext } from "#runtime-context";

type ServerRow = typeof servers.$inferSelect;

export interface DeployClients {
  buildClient: SshClient;
  buildDocker: DockerApi;
  managerClient: SshClient;
  managerDocker: DockerApi;
  sameConnection: boolean;
}

/**
 * Open the build/manager pair for `server`, run `fn`, always disconnect.
 * Manager is closed first when distinct (matches the dominant teardown
 * order across deploy/compose/database paths).
 *
 * Uses `ctx.connectForDeploy` and `ctx.createDockerApi` so tests can swap
 * adapters without touching handler code (architecture review C4).
 */
export async function withDeployClients<T>(
  ctx: DeployContext,
  server: ServerRow,
  fn: (clients: DeployClients) => Promise<T>
): Promise<T> {
  const { buildClient, managerClient, sameConnection } =
    await ctx.connectForDeploy(server);
  const buildDocker = ctx.createDockerApi(buildClient);
  const managerDocker = sameConnection
    ? buildDocker
    : ctx.createDockerApi(managerClient);

  try {
    return await fn({
      buildClient,
      buildDocker,
      managerClient,
      managerDocker,
      sameConnection,
    });
  } finally {
    if (!sameConnection) {
      disconnect(managerClient);
    }
    disconnect(buildClient);
  }
}
