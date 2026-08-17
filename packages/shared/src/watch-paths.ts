import { matchesGlob } from "node:path";

/**
 * Does a push that touched `changedFiles` deserve a deploy?
 *
 * `node:path.matchesGlob` rather than a glob dependency: it is present and
 * behaves identically on both runtimes this repo targets (Node 24 for the
 * worker, Bun for the web app) — measured on `src/**`, `dist/*.js` and
 * `**\/*.ts` before choosing it.
 *
 * An empty list deploys on every push: a filter nobody configured must not
 * silently stop deployments.
 */
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
