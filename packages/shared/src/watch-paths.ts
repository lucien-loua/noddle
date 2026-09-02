import { matchesGlob } from "node:path";

export function shouldDeployPaths(
  watchPaths: readonly string[],
  changedFiles: readonly string[]
): boolean {
  if (watchPaths.length === 0) {
    return true;
  }
  return changedFiles.some((file) =>
    watchPaths.some((pattern) => matchesGlob(file, pattern))
  );
}
