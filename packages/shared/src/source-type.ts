import type { ServiceGitProviderInput, ServiceSourceType } from "./validation/service.ts";

/**
 * What choosing a source type IMPLIES about a Service's other fields.
 *
 * A domain rule, not a form detail: the same rule decides what a save writes
 * and what any other caller would have to write. It lived inside a React
 * mutation, where the only way to exercise it was to render the screen.
 */

/** `compose` is not reachable from the Provider tabs — a Stack, not a Service. */
type PatchableSourceType = Exclude<ServiceSourceType, "compose">;

export interface SourcePatch {
  buildMethod?: "railpack" | "dockerfile" | "image";
  buildPath?: string;
  deployKeyId?: string | null;
  dockerImage?: string;
  gitBranch?: string;
  gitProviderId?: string | null;
  gitRepoFullName?: string | null;
  gitRepoUrl?: string;
  gitSubmodules?: boolean;
  sourceType: PatchableSourceType;
  watchPaths?: string[];
}

/**
 * The git tabs. `git` is BY URL by definition, so it drops the connection
 * and the forge's repository name with it — a stale name would match another
 * repository's pushes, and a stale connection would keep cloning through a
 * forge the screen no longer shows.
 */
export function gitSourcePatch(
  sourceType: "git" | "github" | "gitlab",
  value: ServiceGitProviderInput,
  current: { buildMethod: "railpack" | "dockerfile" | "image" },
): SourcePatch {
  const byUrl = sourceType === "git";
  return {
    // Coming back from the Docker tab, the image build method no longer
    // describes anything. Left alone, the service would deploy a git source
    // as though it were a published image.
    buildMethod: current.buildMethod === "image" ? "railpack" : undefined,
    buildPath: value.buildPath,
    deployKeyId: value.deployKeyId,
    gitBranch: value.gitBranch,
    gitProviderId: byUrl ? null : value.gitProviderId,
    gitRepoFullName: byUrl ? null : value.gitRepoFullName,
    gitRepoUrl: value.gitRepoUrl,
    gitSubmodules: value.gitSubmodules,
    sourceType,
    watchPaths: value.watchPaths,
  };
}

/** The Docker tab: a published image is not built, so the method is forced. */
export function dockerSourcePatch(dockerImage: string): SourcePatch {
  return { buildMethod: "image", dockerImage, sourceType: "docker_image" };
}
