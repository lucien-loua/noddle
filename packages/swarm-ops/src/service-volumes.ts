import type { DockerApi } from "@noddle/ssh-executor";

export interface ServiceVolumeMount {
  mountPath: string;
  volumeName: string;
}

interface SwarmMount {
  Source?: string;
  Target?: string;
  Type?: string;
}

interface ContainerMount {
  Destination?: string;
  Name?: string;
  Type?: string;
}

function mountsFromServiceSpec(
  mounts: SwarmMount[] | undefined
): ServiceVolumeMount[] {
  if (!mounts) {
    return [];
  }
  return mounts
    .filter((m) => m.Type === "volume" && m.Source && m.Target)
    .map((m) => ({
      mountPath: m.Target as string,
      volumeName: m.Source as string,
    }));
}

function dedupeMounts(mounts: ServiceVolumeMount[]): ServiceVolumeMount[] {
  const seen = new Set<string>();
  const out: ServiceVolumeMount[] = [];
  for (const mount of mounts) {
    if (seen.has(mount.volumeName)) {
      continue;
    }
    seen.add(mount.volumeName);
    out.push(mount);
  }
  return out;
}

function mountsFromTaskTemplate(taskTemplate: unknown): ServiceVolumeMount[] {
  if (
    typeof taskTemplate !== "object" ||
    taskTemplate === null ||
    !("ContainerSpec" in taskTemplate)
  ) {
    return [];
  }
  const containerSpec = taskTemplate.ContainerSpec;
  if (typeof containerSpec !== "object" || containerSpec === null) {
    return [];
  }
  const mounts =
    "Mounts" in containerSpec
      ? (containerSpec.Mounts as SwarmMount[] | undefined)
      : undefined;
  return mountsFromServiceSpec(mounts);
}

async function mountsFromRunningTask(
  docker: DockerApi,
  serviceName: string
): Promise<ServiceVolumeMount[]> {
  const tasks = (await docker.listTasks({
    filters: JSON.stringify({ service: [serviceName] }),
  })) as {
    Status?: { ContainerStatus?: { ContainerID?: string }; State?: string };
  }[];
  const running = tasks.find((t) => t.Status?.State === "running");
  const containerId = running?.Status?.ContainerStatus?.ContainerID;
  if (!containerId) {
    return [];
  }

  const inspect = (await docker.getContainer(containerId).inspect()) as {
    Mounts?: ContainerMount[];
  };

  return (inspect.Mounts ?? [])
    .filter((m) => m.Type === "volume" && m.Name && m.Destination)
    .map((m) => ({
      mountPath: m.Destination as string,
      volumeName: m.Name as string,
    }));
}

export async function listServiceVolumeMounts(
  docker: DockerApi,
  serviceName: string
): Promise<ServiceVolumeMount[]> {
  const list = await docker.listServices({
    filters: JSON.stringify({ name: [serviceName] }),
  });
  const found = list.find((s) => s.Spec?.Name === serviceName);
  const specMounts = mountsFromTaskTemplate(found?.Spec?.TaskTemplate);
  const taskMounts = await mountsFromRunningTask(docker, serviceName);

  return dedupeMounts([...specMounts, ...taskMounts]).toSorted((a, b) =>
    a.volumeName.localeCompare(b.volumeName)
  );
}
