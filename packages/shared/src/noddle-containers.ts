export const BUILDKIT_CONTAINER = "noddle-buildkit";

export const LEGACY_BUILDKIT_CONTAINER = "buildx_buildkit_noddle-builder0";

const OWNED = new Set<string>([BUILDKIT_CONTAINER, LEGACY_BUILDKIT_CONTAINER]);

export function isNoddleOwnedContainer(name: string): boolean {
  return OWNED.has(name);
}
