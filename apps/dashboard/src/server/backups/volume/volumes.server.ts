import { listServiceVolumeMounts } from "@noddle/deploy-engine/ops";
import { swarmServiceName } from "@noddle/shared/swarm-names";
import { dockerClient } from "@noddle/ssh-executor";

import { guarded } from "@/lib/guarded.server";
import { withManagerSession } from "@/lib/ssh.server";

import type { ServiceVolumeRow } from "./volumes";

export async function loadServiceVolumeMounts(
  serviceId: string
): Promise<ServiceVolumeRow[]> {
  const service = await guarded.service(serviceId).load();
  if (!service) {
    throw new Error("service not found");
  }

  return await withManagerSession(async (client) => {
    const docker = dockerClient(client);
    return await listServiceVolumeMounts(docker, swarmServiceName(service));
  });
}

export async function assertVolumeAttachedToService(
  serviceId: string,
  volumeName: string
): Promise<void> {
  const mounts = await loadServiceVolumeMounts(serviceId);
  if (mounts.some((m) => m.volumeName === volumeName)) {
    return;
  }
  if (mounts.length === 0) {
    throw new Error(
      "this service has no Docker volumes attached: add a named volume to the deployment, deploy, then try again"
    );
  }
  throw new Error(
    `volume "${volumeName}" is not attached to this service: choose ${mounts.map((m) => m.volumeName).join(", ")}`
  );
}
