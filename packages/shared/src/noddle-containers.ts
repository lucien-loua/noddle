/**
 * The containers Noddle starts on a target with a plain `docker run`.
 *
 * They carry NO labels — measured, `{}` — so nothing ON the machine says
 * they belong to Noddle: they are recognised by NAME. Which means the
 * name has to be the same string in the code that CREATES them and in the
 * code that PROTECTS them, and it was not: the Containers page still knew
 * only `buildx_buildkit_noddle-builder0`, the pre-railpack builder, while
 * `ensureCappedBuilder` had been starting `noddle-buildkit` since. The
 * capped build daemon therefore listed as an ordinary container, with
 * Remove offered on it — from a Noddle screen, on the thing that gives
 * Noddle its ability to build.
 *
 * Everything else Noddle runs comes from the installer's Compose project
 * or from Swarm, and carries a label that already says so.
 */

/** The BuildKit daemon `ensureCappedBuilder` runs. */
export const BUILDKIT_CONTAINER = "noddle-buildkit";

/** The pre-railpack builder: still present on servers provisioned before
 *  the switch, and just as destructive to remove. */
export const LEGACY_BUILDKIT_CONTAINER = "buildx_buildkit_noddle-builder0";

const OWNED = new Set<string>([BUILDKIT_CONTAINER, LEGACY_BUILDKIT_CONTAINER]);

/** True for a container Noddle started itself and nothing else labels. */
export function isNoddleOwnedContainer(name: string): boolean {
  return OWNED.has(name);
}
