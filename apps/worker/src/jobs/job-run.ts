import type { servers } from "@noddle/db/schema";
import { disconnect } from "@noddle/ssh-executor";
import type { DockerApi, SshClient } from "@noddle/ssh-executor";

import type { DeployContext } from "#runtime-context";

type ServerRow = typeof servers.$inferSelect;

export interface DeployClients {
  buildClient: SshClient;
  buildDocker: DockerApi;
  managerClient: SshClient;
  managerDocker: DockerApi;
  sameConnection: boolean;
}

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
