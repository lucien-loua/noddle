import { z } from "zod";

import { BRANCH_FORBIDDEN_CHARS, GIT_SSH_URL, HTTPS_URL } from "./common.ts";
import { environmentNameSchema, projectNameSchema } from "./project.ts";
import { registrySchema } from "./registry.ts";

export const serviceNameSchema = z
  .string()
  .min(1, "Give this service a name.")
  .max(48, "Keep the name under 48 characters.")
  .regex(
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/,
    "lowercase letters, digits and dashes; cannot start or end with a dash"
  );

export const serviceDisplayNameSchema = z
  .string()
  .trim()
  .max(48, "Keep the name under 48 characters.");

export const renameServiceSchema = z.object({
  displayName: serviceDisplayNameSchema,
  serviceId: z.uuid("Choose a service."),
});

export const renameDatabaseSchema = z.object({
  databaseId: z.uuid("Choose a database."),
  displayName: serviceDisplayNameSchema,
});

export const renameStackSchema = z.object({
  displayName: serviceDisplayNameSchema,
  stackId: z.uuid("Choose a stack."),
});

export const gitRepoUrlSchema = z
  .string()
  .min(1, "Enter the repository URL.")
  .max(512, "Keep the URL under 512 characters.")
  .refine(
    (v) => HTTPS_URL.test(v) || GIT_SSH_URL.test(v),
    "expected an https:// URL or git@host:path"
  );

export const gitBranchSchema = z
  .string()
  .min(1, "Enter a branch name.")
  .max(255, "Keep the branch name under 255 characters.")
  .refine(
    (v) => !BRANCH_FORBIDDEN_CHARS.test(v),
    "character not allowed in a branch name"
  )
  .refine((v) => !v.includes(".."), "`..` is not allowed in a branch name")
  .refine((v) => !v.endsWith(".lock"), "a branch name cannot end with .lock");

export const publishDirectorySchema = z
  .string()
  .max(512, "Keep the path under 512 characters.")
  .regex(
    /^(?:[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*)?$/,
    "expected a relative path such as dist or build/out"
  );

const optionalPublishDirectory = z.union(
  [z.literal(""), publishDirectorySchema],
  "expected a relative path such as dist or build/out"
);

export const buildPathSchema = z
  .string()
  .max(512, "Keep the path under 512 characters.")
  .regex(
    /^(?:[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*)?$/,
    "expected a relative path such as apps/dashboard"
  )
  .refine(
    (v) => !v.split("/").includes(".."),
    "`..` is not allowed in a build path"
  );

export const watchPathsSchema = z
  .array(
    z
      .string()
      .min(1, "Enter a path.")
      .max(512, "Keep the path under 512 characters.")
  )
  .max(50, "at most 50 watch paths");

export const domainSchema = z
  .string()
  .min(1, "Enter a domain.")
  .max(253, "Keep the domain under 253 characters.")
  .regex(
    /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/,
    "invalid domain name"
  );

export const gitSourceTypeSchema = z.enum(
  ["git", "github", "gitlab"],
  "Choose a Git provider."
);

export const serviceSourceTypeSchema = z.enum(
  ["git", "github", "gitlab", "docker_image", "compose"],
  "Choose a source type."
);

export const serviceInputSchema = z.object({
  buildMethod: z
    .enum(["railpack", "dockerfile", "image"], "Choose a build method.")
    .default("railpack"),
  domain: domainSchema.optional(),
  gitBranch: gitBranchSchema.default("main"),
  gitRepoUrl: gitRepoUrlSchema.optional(),
  name: serviceNameSchema,
  port: z
    .number({ error: "Enter a port number." })
    .int("Enter a whole port number.")
    .min(1, "Ports start at 1.")
    .max(65_535, "Ports stop at 65535.")
    .default(3000),
  sourceType: serviceSourceTypeSchema,
});

export const connectRepoSchema = z.object({
  environmentName: environmentNameSchema,
  name: serviceDisplayNameSchema.min(1, "Give this service a name."),
  projectName: projectNameSchema,
  serverId: z.uuid("Choose a server."),
});

const optionalGitRepoUrl = z.union(
  [z.literal(""), gitRepoUrlSchema],
  "expected an https:// URL or git@host:path"
);

export const dockerImageSchema = z
  .string()
  .min(1, "Enter an image reference.")
  .max(200, "Keep the image reference under 200 characters.")
  .regex(/^[\w][\w.\-/:@]*$/, "not a valid image reference");

const optionalDockerImage = z.union(
  [z.literal(""), dockerImageSchema],
  "not a valid image reference"
);

export const serviceGitProviderSchema = z.object({
  buildPath: buildPathSchema,
  deployKeyId: z.union([z.uuid(), z.null()], "Choose a deploy key."),
  gitBranch: gitBranchSchema,
  gitProviderId: z.union([z.uuid(), z.null()], "Choose a Git provider."),
  gitRepoFullName: z.union(
    [
      z.string().max(512, "Keep the repository name under 512 characters."),
      z.null(),
    ],
    "Keep the repository name under 512 characters."
  ),
  gitRepoUrl: optionalGitRepoUrl,
  gitSubmodules: z.boolean(),
  watchPaths: watchPathsSchema,
});

export const NEW_REGISTRY = "new";
export const BUILT_IN_REGISTRY = "";

export const serviceDockerProviderSchema = z
  .object({
    dockerImage: optionalDockerImage,
    registryChoice: z.string(),
    registryName: z.string(),
    registryPassword: z.string(),
    registryUrl: z.string(),
    registryUsername: z.string(),
  })
  .superRefine((value, ctx) => {
    if (value.registryChoice !== NEW_REGISTRY) {
      return;
    }
    const borrowed = [
      ["registryName", registrySchema.shape.name],
      ["registryUrl", registrySchema.shape.registryUrl],
      ["registryUsername", registrySchema.shape.username],
    ] as const;
    for (const [path, schema] of borrowed) {
      const parsed = schema.safeParse(value[path]);
      const message = parsed.success ? null : parsed.error.issues[0]?.message;
      if (message) {
        ctx.addIssue({ code: "custom", message, path: [path] });
      }
    }
    if (value.registryPassword.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "The registry needs a password or token.",
        path: ["registryPassword"],
      });
    }
  });

export const serviceProviderSchema = serviceGitProviderSchema;

export const serviceBuildSchema = z.object({
  buildMethod: z.enum(["railpack", "dockerfile"], "Choose a build method."),
  publishDirectory: optionalPublishDirectory,
});

export const certificateTypeSchema = z.enum(
  ["none", "letsencrypt"],
  "Choose a certificate type."
);

export const routePathSchema = z.union(
  [
    z.literal(""),
    z.literal("/"),
    z
      .string()
      .max(512, "Keep the path under 512 characters.")
      .regex(
        /^\/[a-zA-Z0-9/._-]*$/,
        "path must start with / and contain only safe characters"
      ),
  ],
  "path must start with / and contain only safe characters"
);

const optionalInternalPath = z.union(
  [
    z.literal(""),
    z
      .string()
      .max(512, "Keep the path under 512 characters.")
      .regex(
        /^\/[a-zA-Z0-9/._-]*$/,
        "internal path must start with / and contain only safe characters"
      ),
  ],
  "internal path must start with / and contain only safe characters"
);

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
  port: z
    .number({ error: "Enter a port number." })
    .int("Enter a whole port number.")
    .min(1, "Ports start at 1.")
    .max(65_535, "Ports stop at 65535."),
  stripPath: z.boolean(),
});

export const serviceDomainsSchema =
  serviceDomainFieldsSchema.superRefine(domainTlsRefine);

export const createServiceDomainSchema = serviceDomainFieldsSchema
  .extend({ serviceId: z.uuid("Choose a service.") })
  .superRefine(domainTlsRefine);

export const updateServiceDomainSchema = serviceDomainFieldsSchema
  .extend({ domainId: z.uuid("Choose a domain.") })
  .superRefine(domainTlsRefine);

export const deleteServiceDomainSchema = z.object({
  domainId: z.uuid("Choose a domain."),
});

export const generateServiceDomainHostSchema = z.object({
  serviceId: z.uuid("Choose a service."),
});

export const updateServiceSettingsSchema = z.object({
  autoDeploy: z.boolean().optional(),
  buildMethod: z
    .enum(["railpack", "dockerfile", "image"], "Choose a build method.")
    .optional(),
  buildPath: buildPathSchema.optional(),
  cleanCache: z.boolean().optional(),
  deployKeyId: z.union([z.uuid(), z.null()], "Choose a deploy key.").optional(),
  dockerImage: optionalDockerImage.optional(),
  gitBranch: gitBranchSchema.optional(),
  gitProviderId: z
    .union([z.uuid(), z.null()], "Choose a Git provider.")
    .optional(),
  gitRepoFullName: z
    .union(
      [
        z.string().max(512, "Keep the repository name under 512 characters."),
        z.null(),
      ],
      "Keep the repository name under 512 characters."
    )
    .optional(),
  gitRepoUrl: optionalGitRepoUrl.optional(),
  gitSubmodules: z.boolean().optional(),
  publishDirectory: optionalPublishDirectory.optional(),
  serviceId: z.uuid("Choose a service."),
  sourceType: z
    .enum(["git", "github", "gitlab", "docker_image"], "Choose a source type.")
    .optional(),
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
  commitSha: z
    .string()
    .regex(/^[0-9a-f]{7,40}$/, "invalid commit SHA")
    .optional(),
  serviceId: z.uuid("Choose a service."),
});

export type DeployRequest = z.infer<typeof deployRequestSchema>;

export const lifecycleRequestSchema = z.object({
  action: z.enum(["start", "stop", "restart"], "Choose an action."),
  serviceId: z.uuid("Choose a service."),
});

export type LifecycleRequest = z.infer<typeof lifecycleRequestSchema>;

export const rollbackRequestSchema = z.object({
  deploymentId: z.uuid("Choose a deployment."),
  serviceId: z.uuid("Choose a service."),
});

export type RollbackRequest = z.infer<typeof rollbackRequestSchema>;

export const moveServiceSchema = z.object({
  environmentId: z.uuid("Choose an environment."),
  serviceId: z.uuid("Choose a service."),
});

export const deleteServiceSchema = z.object({
  confirmName: z
    .string()
    .min(1, "Type the service name to confirm.")
    .max(48, "Keep the name under 48 characters."),
  serviceId: z.uuid("Choose a service."),
});

export type DeleteServiceRequest = z.infer<typeof deleteServiceSchema>;
