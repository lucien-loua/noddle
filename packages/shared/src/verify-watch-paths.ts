// tier: pure
// bun run packages/shared/src/verify-watch-paths.ts

import { check, runVerify } from "@noddle/testing";
import { shouldDeployPaths } from "#watch-paths";

await runVerify("watch paths", () => {
  check(
    "no watch path configured deploys every push",
    shouldDeployPaths([], ["anything.txt"]) && shouldDeployPaths([], [])
  );

  check(
    "a watched directory matches at any depth",
    shouldDeployPaths(["src/**"], ["src/index.ts"]) &&
      shouldDeployPaths(["src/**"], ["src/a/b/c.ts"])
  );

  check(
    "an unwatched change does not deploy",
    !shouldDeployPaths(["src/**"], ["docs/readme.md"])
  );

  check(
    "one matching file among many is enough",
    shouldDeployPaths(["apps/web/**"], ["README.md", "apps/web/src/main.tsx"])
  );

  check(
    "any pattern in the list can match",
    shouldDeployPaths(["apps/web/**", "package.json"], ["package.json"])
  );

  check(
    "a single star does not cross a directory boundary",
    shouldDeployPaths(["dist/*.js"], ["dist/app.js"]) &&
      !shouldDeployPaths(["dist/*.js"], ["dist/nested/app.js"])
  );

  check(
    "a bare filename does not match the same name in a subdirectory",
    shouldDeployPaths(["package.json"], ["package.json"]) &&
      !shouldDeployPaths(["package.json"], ["apps/web/package.json"])
  );

  // A push whose payload carried no file list, with a filter configured.
  // Not deploying is the honest answer: nothing PROVES a watched path moved.
  check(
    "a configured filter with no readable file blocks the deploy",
    !shouldDeployPaths(["src/**"], [])
  );
});
