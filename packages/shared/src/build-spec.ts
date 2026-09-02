export const BUILD_SPEC_FIELDS = [
  "autoDeploy",
  "buildMethod",
  "buildPath",
  "cleanCache",
  "deployKeyId",
  "dockerImage",
  "gitBranch",
  "gitProviderId",
  "gitRepoFullName",
  "gitRepoUrl",
  "gitSubmodules",
  "port",
  "publishDirectory",
  "registryId",
  "sourceType",
  "watchPaths",
] as const;

export const SERVICE_IDENTITY_FIELDS = [
  "createdAt",
  "currentDeploymentId",
  "displayName",
  "environmentId",
  "id",
  "lastError",
  "name",
  "prNumber",
  "previewOfServiceId",
  "serverId",
  "status",
  "updatedAt",
  "webhookSecretEncrypted",
] as const;

export type BuildSpecField = (typeof BUILD_SPEC_FIELDS)[number];

export function buildSpecOf<T extends Record<BuildSpecField, unknown>>(
  service: T
): Pick<T, BuildSpecField> {
  const spec = {} as Pick<T, BuildSpecField>;
  for (const field of BUILD_SPEC_FIELDS) {
    spec[field] = service[field];
  }
  return spec;
}
