export const RAILPACK_VERSION = "0.36.4";

export function railpackInstallCommand(sudo = "sudo"): string {
  return `export RAILPACK_VERSION=${RAILPACK_VERSION} && curl -sSL https://railpack.com/install.sh | ${sudo} -E sh`;
}

export const BUILDKIT_IMAGE = "moby/buildkit:v0.27.0";
