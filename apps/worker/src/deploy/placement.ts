import { isPortableImage } from "@noddle/registry";
import type { RegistryConfig } from "@noddle/registry";
import type { DockerApi } from "@noddle/ssh-executor";
import { getSwarmNodeId } from "@noddle/swarm-ops";
import type { RegistryAuth } from "@noddle/swarm-ops";

/**
 * Should this image be pinned to a node, and which one?
 *
 * THE question behind this whole effort, and it's decided image by image —
 * never by a global setting.
 *
 * A registry image is reachable from any node: no constraint, Swarm places
 * it wherever it wants, and that's the whole point. A local image exists
 * ONLY on the node that built it: without a constraint, the scheduler would
 * pick another one and the task would never start.
 *
 * This is what makes the migration free. A rollback to a deployment from
 * before the registry carries an unqualified tag, so it stays pinned to the
 * right node and keeps working, while new deployments are free to move.
 * Nothing to re-push, nothing to rewrite in history.
 */
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

/** What Swarm distributes to its agents so THEY can pull. */
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
