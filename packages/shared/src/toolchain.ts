/**
 * Versions Noddle installs on a target, pinned.
 *
 * Noddle installs these itself, so it owns both halves of the compatibility
 * pair — the same reasoning that pins Traefik in the installer. Left
 * floating, two servers added a month apart get different toolchains and
 * build differently, and an upstream regression arrives without a line of
 * Noddle changing.
 *
 * `NIXPACKS_VERSION` in particular is what the project's build rules were
 * MEASURED against: on 1.41.0, `--apt` and `--pkgs` wipe the nix overlay
 * list and break every Node build. That measurement is only true of the
 * version it was taken on.
 */
export const NIXPACKS_VERSION = "1.41.0";

/** The install line, with the version pinned. */
export function nixpacksInstallCommand(sudo = "sudo"): string {
  return `export NIXPACKS_VERSION=${NIXPACKS_VERSION} && curl -sSL https://nixpacks.com/install.sh | ${sudo} -E bash`;
}
