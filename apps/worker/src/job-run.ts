/**
 * Owns the SSH connection pair for a worker job: open, hand over, close
 * once — in one order. Call sites used to copy four divergent `finally`
 * blocks; this is the single teardown.
 */
import type { servers } from "@noddle/db/schema";
import {
  type DockerApi,
  disconnect,
  dockerClient,
  type SshClient,
} from "@noddle/ssh-executor";
import { connectForDeploy, type DeployContext } from "#deploy";

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
 */
export async function withDeployClients<T>(
  ctx: DeployContext,
  server: ServerRow,
  fn: (clients: DeployClients) => Promise<T>
): Promise<T> {
  const { buildClient, managerClient, sameConnection } = await connectForDeploy(
    ctx,
    server
  );
  const buildDocker = dockerClient(buildClient);
  const managerDocker = sameConnection
    ? buildDocker
    : dockerClient(managerClient);

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
