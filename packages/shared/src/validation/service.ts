import { z } from "zod";
import { BRANCH_FORBIDDEN_CHARS, GIT_SSH_URL, HTTPS_URL } from "./common.ts";
import { environmentNameSchema, projectNameSchema } from "./project.ts";

/**
 * The name becomes a Swarm service name and a Traefik router name. Neither
 * accepts just anything, and a rejected name must not be discovered at
 * deploy time.
 */
export const serviceNameSchema = z
  .string()
  .min(1)
  .max(48)
  .regex(
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/,
    "lowercase letters, digits and dashes; cannot start or end with a dash"
  );

export const gitRepoUrlSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (v) => HTTPS_URL.test(v) || GIT_SSH_URL.test(v),
    "expected an https:// URL or git@host:path"
  );

export const gitBranchSchema = z
  .string()
  .min(1)
  .max(255)
  // Git's own restrictions: no space, no `..`, no `~^:?*[`, no ending in
  // `.lock`. An invalid branch would make the clone fail.
  .refine(
    (v) => !BRANCH_FORBIDDEN_CHARS.test(v),
    "character not allowed in a branch name"
  )
  .refine((v) => !v.includes(".."), "`..` is not allowed in a branch name")
  .refine((v) => !v.endsWith(".lock"), "a branch name cannot end with .lock");

/** Relative output folder inside the repo — no leading slash, no `..`. */
export const publishDirectorySchema = z
  .string()
  .max(512)
  .regex(
    /^(?:[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*)?$/,
    "expected a relative path such as dist or build/out"
  );

const optionalPublishDirectory = z.union([
  z.literal(""),
  publishDirectorySchema,
]);

/**
 * Build context inside the repo, for a monorepo. Unlike the publish
 * directory this becomes a `cd` target on the user's SERVER, so `..` is
 * rejected explicitly — the path regex alone would accept it as a segment.
 */
export const buildPathSchema = z
  .string()
  .max(512)
  .regex(
    /^(?:[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*)?$/,
    "expected a relative path such as apps/web"
  )
  .refine(
    (v) => !v.split("/").includes(".."),
    "`..` is not allowed in a build path"
  );

/**
 * One glob per entry, matched against the files a push touched. An empty
 * list means every push deploys — the same default as no filter at all.
 */
export const watchPathsSchema = z
  .array(z.string().min(1).max(512))
  .max(50, "at most 50 watch paths");

export const domainSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(
    /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/,
    "invalid domain name"
  );

export const gitSourceTypeSchema = z.enum(["git", "github", "gitlab"]);

export const serviceSourceTypeSchema = z.enum([
  "git",
  "github",
  "gitlab",
  "docker_image",
  "compose",
]);

export const serviceInputSchema = z.object({
  buildMethod: z.enum(["railpack", "dockerfile", "image"]).default("railpack"),
  domain: domainSchema.optional(),
  gitBranch: gitBranchSchema.default("main"),
  gitRepoUrl: gitRepoUrlSchema.optional(),
  name: serviceNameSchema,
  port: z.number().int().min(1).max(65_535).default(3000),
  sourceType: serviceSourceTypeSchema,
});

/**
 * Create an application — name and server only. Source, build and domain
 * are configured on the service page, then Deploy. Default source is
 * `git`; the Provider tabs switch it after creation.
 */
export const connectRepoSchema = z.object({
  environmentName: environmentNameSchema,
  name: serviceNameSchema,
  projectName: projectNameSchema,
  serverId: z.uuid(),
});

/** Empty string from a form field means "clear", not "invalid". */
const optionalGitRepoUrl = z.union([z.literal(""), gitRepoUrlSchema]);

/**
 * Same rules as a database image ref: reject what would break the command
 * line, not a catalogue of registries. Duplicated rather than imported
 * from the database schema — that file already imports this one.
 */
export const dockerImageSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[\w][\w.\-/:@]*$/, "not a valid image reference");

const optionalDockerImage = z.union([z.literal(""), dockerImageSchema]);

export const serviceGitProviderSchema = z.object({
  buildPath: buildPathSchema,
  /** `null` = clone anonymously. */
  deployKeyId: z.union([z.uuid(), z.null()]),
  gitBranch: gitBranchSchema,
  /** `null` = clone by URL rather than through a connected forge. */
  gitProviderId: z.union([z.uuid(), z.null()]),
  gitRepoUrl: optionalGitRepoUrl,
  gitSubmodules: z.boolean(),
  watchPaths: watchPathsSchema,
});

export const serviceDockerProviderSchema = z.object({
  dockerImage: optionalDockerImage,
});

export const serviceProviderSchema = serviceGitProviderSchema;

export const serviceBuildSchema = z.object({
  buildMethod: z.enum(["railpack", "dockerfile"]),
  publishDirectory: optionalPublishDirectory,
});

export const certificateTypeSchema = z.enum(["none", "letsencrypt"]);

/** URL path segment safe for Traefik rules and middleware prefixes. */
export const routePathSchema = z.union([
  z.literal(""),
  z.literal("/"),
  z
    .string()
    .max(512)
    .regex(
      /^\/[a-zA-Z0-9/._-]*$/,
      "path must start with / and contain only safe characters"
    ),
]);

const optionalInternalPath = z.union([
  z.literal(""),
  z
    .string()
    .max(512)
    .regex(
      /^\/[a-zA-Z0-9/._-]*$/,
      "internal path must start with / and contain only safe characters"
    ),
]);

const domainTlsRefine = (
  value: {
    certificateType: z.infer<typeof certificateTypeSchema>;
    https: boolean;
  },
  ctx: z.RefinementCtx
) => {
  if (!value.https && value.certificateType === "letsencrypt") {
    ctx.addIssue({
      code: "custom",
      message: "Let's Encrypt requires HTTPS to be enabled",
      path: ["certificateType"],
    });
  }
};

const serviceDomainFieldsSchema = z.object({
  certificateType: certificateTypeSchema,
  host: domainSchema,
  https: z.boolean(),
  internalPath: optionalInternalPath.optional(),
  path: routePathSchema.optional(),
  port: z.number().int().min(1).max(65_535),
  stripPath: z.boolean(),
});

export const serviceDomainsSchema =
  serviceDomainFieldsSchema.superRefine(domainTlsRefine);

export const createServiceDomainSchema = serviceDomainFieldsSchema
  .extend({ serviceId: z.uuid() })
  .superRefine(domainTlsRefine);

export const updateServiceDomainSchema = serviceDomainFieldsSchema
  .extend({ domainId: z.uuid() })
  .superRefine(domainTlsRefine);

export const deleteServiceDomainSchema = z.object({
  domainId: z.uuid(),
});

export const generateServiceDomainHostSchema = z.object({
  serviceId: z.uuid(),
});

/**
 * Source, build and public access — saved from General / Domains, never
 * at create time. A missing git URL or docker image blocks Deploy, it
 * does not block Save.
 */
export const updateServiceSettingsSchema = z.object({
  autoDeploy: z.boolean().optional(),
  buildMethod: z.enum(["railpack", "dockerfile", "image"]).optional(),
  buildPath: buildPathSchema.optional(),
  cleanCache: z.boolean().optional(),
  deployKeyId: z.union([z.uuid(), z.null()]).optional(),
  dockerImage: optionalDockerImage.optional(),
  gitBranch: gitBranchSchema.optional(),
  gitProviderId: z.union([z.uuid(), z.null()]).optional(),
  gitRepoUrl: optionalGitRepoUrl.optional(),
  gitSubmodules: z.boolean().optional(),
  publishDirectory: optionalPublishDirectory.optional(),
  serviceId: z.uuid(),
  sourceType: z.enum(["git", "github", "gitlab", "docker_image"]).optional(),
  watchPaths: watchPathsSchema.optional(),
});

export type ConnectRepoInput = z.infer<typeof connectRepoSchema>;

export type ServiceBuildInput = z.infer<typeof serviceBuildSchema>;

export type ServiceDomainsInput = z.infer<typeof serviceDomainsSchema>;

export type CertificateTypeInput = z.infer<typeof certificateTypeSchema>;

export type CreateServiceDomainInput = z.infer<
  typeof createServiceDomainSchema
>;

export type UpdateServiceDomainInput = z.infer<
  typeof updateServiceDomainSchema
>;

export type ServiceInput = z.infer<typeof serviceInputSchema>;

export type ServiceProviderInput = z.infer<typeof serviceProviderSchema>;

export type ServiceGitProviderInput = z.infer<typeof serviceGitProviderSchema>;

export type ServiceDockerProviderInput = z.infer<
  typeof serviceDockerProviderSchema
>;

export type GitSourceType = z.infer<typeof gitSourceTypeSchema>;

export type ServiceSourceType = z.infer<typeof serviceSourceTypeSchema>;

export function isGitSourceType(
  sourceType: string
): sourceType is GitSourceType {
  return (
    sourceType === "git" || sourceType === "github" || sourceType === "gitlab"
  );
}

export type UpdateServiceSettingsInput = z.infer<
  typeof updateServiceSettingsSchema
>;

export const deployRequestSchema = z.object({
  /** Absent = HEAD of the configured branch. */
  commitSha: z
    .string()
    .regex(/^[0-9a-f]{7,40}$/, "invalid commit SHA")
    .optional(),
  serviceId: z.uuid(),
});

export type DeployRequest = z.infer<typeof deployRequestSchema>;

/**
 * Stop, restart, relaunch.
 *
 * The three travel together because they share a consequence: none of
 * them destroys anything and all of them are recoverable by their
 * opposite. That's what groups them with `deploy` and not with `delete`
 * in the permissions model.
 */
export const lifecycleRequestSchema = z.object({
  action: z.enum(["start", "stop", "restart"]),
  serviceId: z.uuid(),
});

export type LifecycleRequest = z.infer<typeof lifecycleRequestSchema>;

export const rollbackRequestSchema = z.object({
  /**
   * The deployment to roll back to. Explicit, not "the previous one":
   * Noddle keeps the whole history and can target any version, whereas
   * Swarm only keeps one prior spec.
   */
  deploymentId: z.uuid(),
  serviceId: z.uuid(),
});

export type RollbackRequest = z.infer<typeof rollbackRequestSchema>;

export const moveServiceSchema = z.object({
  environmentId: z.uuid(),
  serviceId: z.uuid(),
});

/**
 * Deleting a service is irreversible: the history, images and variables
 * go with it. Same requirement as a restore, hence — `confirmName` carries
 * the typed name to the SERVER, which re-checks it. A dialog only
 * protects clients that display it.
 */
export const deleteServiceSchema = z.object({
  confirmName: z.string().min(1).max(48),
  serviceId: z.uuid(),
});

export type DeleteServiceRequest = z.infer<typeof deleteServiceSchema>;
