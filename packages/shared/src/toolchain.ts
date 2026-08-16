/**
 * Versions Noddle installs on a target, pinned.
 *
 * Noddle installs these itself, so it owns both halves of the compatibility
 * pair — the same reasoning that pins Traefik in the installer. Left
 * floating, two servers added a month apart get different toolchains and
 * build differently, and an upstream regression arrives without a line of
 * Noddle changing.
 *
 * `RAILPACK_VERSION` in particular is what the project's build rules were
 * MEASURED against. That measurement is only true of the version it was
 * taken on.
 */
export const RAILPACK_VERSION = "0.36.4";

/** The install line, with the version pinned. */
export function railpackInstallCommand(sudo = "sudo"): string {
  return `export RAILPACK_VERSION=${RAILPACK_VERSION} && curl -sSL https://railpack.com/install.sh | ${sudo} -E sh`;
}

/**
 * The BuildKit daemon Noddle runs to carry the build cap.
 *
 * Pinned for the same reason as the rest: Noddle starts this container itself,
 * so an upstream change to `latest` would alter build behaviour on existing
 * servers with nothing in the diff. Both build paths share this one daemon —
 * railpack over `BUILDKIT_HOST`, buildx over its `remote` driver — so one
 * cgroup covers every build on the host.
 */
export const BUILDKIT_IMAGE = "moby/buildkit:v0.27.0";
