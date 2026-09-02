import type {
  ServiceGitProviderInput,
  ServiceSourceType,
} from "./validation/service.ts";

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

export function gitSourcePatch(
  sourceType: "git" | "github" | "gitlab",
  value: ServiceGitProviderInput,
  current: { buildMethod: "railpack" | "dockerfile" | "image" }
): SourcePatch {
  const byUrl = sourceType === "git";
  return {
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

export function dockerSourcePatch(dockerImage: string): SourcePatch {
  return { buildMethod: "image", dockerImage, sourceType: "docker_image" };
}
