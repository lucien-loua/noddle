import { z } from "zod";

import { environmentNameSchema, projectNameSchema } from "./project.ts";
import {
  domainSchema,
  gitBranchSchema,
  gitRepoUrlSchema,
  serviceNameSchema,
} from "./service.ts";

/** Same constraint as a compose service name on the worker side: what
 *  follows becomes `${stackName}_${key}` as a Swarm service name. */
export const composeServiceKeySchema = z
  .string()
  .min(1)
  .max(48)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, "invalid compose service key");

const composeFilePathSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(
    /^(?!\/)(?!.*\.\.)[\w./-]+$/,
    "expected a relative path, without escaping the repository"
  )
  .default("docker-compose.yml");

/**
 * "Connect a Compose repo" — like `connectRepoSchema`, but for multiple
 * containers under one name. AT MOST one service receives a Traefik route
 * (`publicService` + `domain` + `port`): that's the common case Compose
 * serves (app + sidecars), not N domains per stack.
 *
 * Split into two: `.refine()` strips `.extend()` from the type it
 * returns, and the form needs to redeclare `domain`/`port` (see their
 * comment in `connect-stack-dialog.tsx`) without redefining the other
 * eight fields.
 */
export const connectStackBaseSchema = z.object({
  composeFilePath: composeFilePathSchema,
  domain: domainSchema.optional(),
  environmentName: environmentNameSchema,
  gitBranch: gitBranchSchema.default("main"),
  gitRepoUrl: gitRepoUrlSchema,
  name: serviceNameSchema,
  port: z.number().int().min(1).max(65_535).optional(),
  projectName: projectNameSchema,
  publicService: composeServiceKeySchema.optional(),
  serverId: z.uuid(),
});

export const connectStackSchema = connectStackBaseSchema.refine(
  (v) => !v.publicService || v.port !== undefined,
  {
    message: "a port is required to expose a service",
    path: ["port"],
  }
);

export type ConnectStackInput = z.infer<typeof connectStackSchema>;

export const stackDeployRequestSchema = z.object({
  stackId: z.uuid(),
});

export type StackDeployRequest = z.infer<typeof stackDeployRequestSchema>;

export const stackRollbackRequestSchema = z.object({
  /** The `stack_deployments` row to roll back to — same principle as
   *  `rollbackRequestSchema`, one per stack rather than per service. */
  sourceDeploymentId: z.uuid(),
  stackId: z.uuid(),
});

export type StackRollbackRequest = z.infer<typeof stackRollbackRequestSchema>;

/**
 * Deleting a stack, a database, a server.
 *
 * All three require RETYPING THE NAME, like a service and like a restore.
 * This isn't UI politeness: the name is re-checked server-side, because a
 * dialog only protects clients that display it.
 *
 * `max(64)` and not 48: a server name follows `serverInputSchema`, wider
 * than `serviceNameSchema`.
 */
export const deleteStackSchema = z.object({
  confirmName: z.string().min(1).max(48),
  stackId: z.uuid(),
});

export type DeleteStackRequest = z.infer<typeof deleteStackSchema>;
