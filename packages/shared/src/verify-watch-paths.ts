// tier: pure
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
    shouldDeployPaths(
      ["apps/dashboard/**"],
      ["README.md", "apps/dashboard/src/main.tsx"]
    )
  );

  check(
    "any pattern in the list can match",
    shouldDeployPaths(["apps/dashboard/**", "package.json"], ["package.json"])
  );

  check(
    "a single star does not cross a directory boundary",
    shouldDeployPaths(["dist/*.js"], ["dist/app.js"]) &&
      !shouldDeployPaths(["dist/*.js"], ["dist/nested/app.js"])
  );

  check(
    "a bare filename does not match the same name in a subdirectory",
    shouldDeployPaths(["package.json"], ["package.json"]) &&
      !shouldDeployPaths(["package.json"], ["apps/dashboard/package.json"])
  );

  check(
    "a configured filter with no readable file blocks the deploy",
    !shouldDeployPaths(["src/**"], [])
  );
});
