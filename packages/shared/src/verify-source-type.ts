// bun run packages/shared/src/verify-source-type.ts
//
// These rules used to live inside a React mutation, where exercising them
// meant rendering the screen. What they decide is not cosmetic: a stale
// connection keeps cloning through a forge the screen no longer shows, and a
// stale repository name matches another repository's pushes.
import { check, runVerify } from "@noddle/testing";
import { dockerSourcePatch, gitSourcePatch } from "./source-type.ts";

const connected = {
  buildPath: "apps/web",
  deployKeyId: null,
  gitBranch: "main",
  gitProviderId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  gitRepoFullName: "group/sub/app",
  gitRepoUrl: "https://gitlab.com/group/sub/app.git",
  gitSubmodules: true,
  watchPaths: ["apps/web/**"],
};

await runVerify("service source type", () => {
  for (const forge of ["github", "gitlab"] as const) {
    const p = gitSourcePatch(forge, connected, { buildMethod: "railpack" });
    check(
      `${forge} keeps the connection and the forge's repository name`,
      p.gitProviderId === connected.gitProviderId &&
        p.gitRepoFullName === "group/sub/app"
    );
    check(`${forge} records its own source type`, p.sourceType === forge);
  }

  // The custom tab is by URL BY DEFINITION.
  const byUrl = gitSourcePatch("git", connected, { buildMethod: "railpack" });
  check(
    "the git tab drops the connection",
    byUrl.gitProviderId === null,
    "a service would keep cloning through a forge the screen no longer shows"
  );
  check(
    "the git tab drops the forge's repository name with it",
    byUrl.gitRepoFullName === null,
    "a stale name would match another repository's pushes"
  );
  check("the git tab keeps the URL the user typed", byUrl.gitRepoUrl !== null);

  // Coming back from the Docker tab.
  check(
    "an image build method is reset when a git source is saved",
    gitSourcePatch("git", connected, { buildMethod: "image" }).buildMethod ===
      "railpack",
    "the service would deploy a git source as though it were a published image"
  );
  for (const buildMethod of ["railpack", "dockerfile"] as const) {
    check(
      `${buildMethod} is left alone`,
      gitSourcePatch("git", connected, { buildMethod }).buildMethod ===
        undefined
    );
  }

  const docker = dockerSourcePatch("nginx:alpine");
  check(
    "the docker tab forces the image method and source type",
    docker.buildMethod === "image" &&
      docker.sourceType === "docker_image" &&
      docker.dockerImage === "nginx:alpine"
  );
  check(
    "the docker tab writes nothing about a git source",
    docker.gitRepoUrl === undefined && docker.gitProviderId === undefined
  );
});
