import { services } from "@noddle/db/schema";
import { swarmServiceName } from "@noddle/shared/swarm-names";
import { disconnect, dockerClient } from "@noddle/ssh-executor";
import { listServiceVolumeMounts } from "@noddle/swarm-ops";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db.server";
import { connectToManager } from "@/lib/ssh.server";
import type { ServiceVolumeRow } from "./volumes";

export async function loadServiceVolumeMounts(
  serviceId: string
): Promise<ServiceVolumeRow[]> {
  const service = await db.query.services.findFirst({
    where: eq(services.id, serviceId),
  });
  if (!service) {
    throw new Error("service not found");
  }

  const client = await connectToManager();
  try {
    const docker = dockerClient(client);
    return await listServiceVolumeMounts(docker, swarmServiceName(service));
  } finally {
    disconnect(client);
  }
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
      "this service has no Docker volumes attached — add a named volume to the deployment, deploy, then try again"
    );
  }
  throw new Error(
    `volume "${volumeName}" is not attached to this service — choose ${mounts.map((m) => m.volumeName).join(", ")}`
  );
}
