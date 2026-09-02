import { isPortableImage, getSwarmNodeId } from "@noddle/deploy-engine";
import type { RegistryConfig, RegistryAuth } from "@noddle/deploy-engine";
import type { DockerApi } from "@noddle/ssh-executor";

export async function placementFor(opts: {
  buildDocker: DockerApi;
  image: string;
  registry: RegistryConfig | undefined;
  swarmNodeId: string | null | undefined;
}): Promise<string | undefined> {
  if (isPortableImage(opts.image, opts.registry)) {
    return;
  }
  return opts.swarmNodeId ?? (await getSwarmNodeId(opts.buildDocker));
}

export function authFor(
  registry: RegistryConfig | undefined
): RegistryAuth | undefined {
  if (!registry) {
    return;
  }
  return {
    password: registry.password,
    serveraddress: registry.host,
    username: registry.username,
  };
}
