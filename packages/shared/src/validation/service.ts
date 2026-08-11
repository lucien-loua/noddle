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

export const domainSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(
    /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/,
    "invalid domain name"
  );

export const serviceInputSchema = z.object({
  buildMethod: z.enum(["nixpacks", "dockerfile", "image"]).default("nixpacks"),
  domain: domainSchema.optional(),
  gitBranch: gitBranchSchema.default("main"),
  gitRepoUrl: gitRepoUrlSchema.optional(),
  name: serviceNameSchema,
  port: z.number().int().min(1).max(65_535).default(3000),
  sourceType: z.enum(["git", "docker_image", "compose"]),
});

/**
 * "Connect a repo" — the only deployment path the worker actually knows
 * how to run today: git repo, nixpacks build. `sourceType` is therefore
 * not a choice here, unlike in `serviceInputSchema`: offering
 * `docker_image` or `compose` in a form before the worker knows how to
 * build them would dangle a feature that would fail on the first
 * deployment.
 */
export const connectRepoSchema = z.object({
  domain: domainSchema.optional(),
  environmentName: environmentNameSchema,
  gitBranch: gitBranchSchema.default("main"),
  gitRepoUrl: gitRepoUrlSchema,
  name: serviceNameSchema,
  port: z.number().int().min(1).max(65_535).default(3000),
  projectName: projectNameSchema,
  serverId: z.uuid(),
});

export type ConnectRepoInput = z.infer<typeof connectRepoSchema>;

export type ServiceInput = z.infer<typeof serviceInputSchema>;

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
