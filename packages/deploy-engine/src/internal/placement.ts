import type { DockerApi } from "@noddle/ssh-executor";

import { isPortableImage } from "./registry.ts";
import type { RegistryConfig } from "./registry.ts";
import { getSwarmNodeId } from "./swarm.ts";

export type PlacementPolicy = "auto" | "pinned" | "portable";

export async function resolvePlacement(opts: {
  buildDocker: DockerApi;
  image?: string;
  policy: PlacementPolicy;
  registry?: RegistryConfig;
  swarmNodeId: string | null;
}): Promise<string | undefined> {
  if (opts.policy === "portable") {
    return;
  }
  if (
    opts.policy === "auto" &&
    isPortableImage(opts.image ?? "", opts.registry)
  ) {
    return;
  }
  return opts.swarmNodeId ?? (await getSwarmNodeId(opts.buildDocker));
}
