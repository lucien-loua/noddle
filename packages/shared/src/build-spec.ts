/**
 * Which fields of a Service decide how it BUILDS and RUNS, as opposed to
 * which Service it is.
 *
 * Everything that creates a Service from another one — a Preview from its
 * parent, a duplicated Environment — used to hand-list them, and each list
 * could omit one silently. `createPreview` omitted four, and the omission
 * shows up as a Preview that builds differently from the parent it is
 * supposed to mirror.
 */
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

/**
 * The rest: identity, placement and lifecycle. Never copied — a copy is a
 * different Service, on its own row, with its own history.
 */
export const SERVICE_IDENTITY_FIELDS = [
  "createdAt",
  "currentDeploymentId",
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

/**
 * The build half of a Service, ready to spread onto a new row.
 *
 * The caller overrides what genuinely differs — a Preview its branch and
 * name — and cannot forget the rest.
 */
export function buildSpecOf<T extends Record<BuildSpecField, unknown>>(
  service: T,
): Pick<T, BuildSpecField> {
  const spec = {} as Pick<T, BuildSpecField>;
  for (const field of BUILD_SPEC_FIELDS) {
    spec[field] = service[field];
  }
  return spec;
}
