import { z } from "zod";

import { environmentNameSchema, projectNameSchema } from "./project.ts";
import {
  domainSchema,
  gitBranchSchema,
  gitRepoUrlSchema,
  serviceNameSchema,
} from "./service.ts";

export const composeServiceKeySchema = z
  .string()
  .min(1, "Enter the compose service name.")
  .max(48, "Keep the name under 48 characters.")
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, "invalid compose service key");

const composeFilePathSchema = z
  .string()
  .min(1, "Enter the compose file path.")
  .max(255, "Keep the path under 255 characters.")
  .regex(
    /^(?!\/)(?!.*\.\.)[\w./-]+$/,
    "expected a relative path, without escaping the repository"
  )
  .default("docker-compose.yml");

export const connectStackBaseSchema = z.object({
  composeFilePath: composeFilePathSchema,
  domain: domainSchema.optional(),
  environmentName: environmentNameSchema,
  gitBranch: gitBranchSchema.default("main"),
  gitRepoUrl: gitRepoUrlSchema,
  name: serviceNameSchema,
  port: z
    .int("Enter a whole port number.")
    .min(1, "Ports start at 1.")
    .max(65_535, "Ports stop at 65535.")
    .optional(),
  projectName: projectNameSchema,
  publicService: composeServiceKeySchema.optional(),
  serverId: z.uuid("Choose a server."),
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
  stackId: z.uuid("Choose a stack."),
});

export type StackDeployRequest = z.infer<typeof stackDeployRequestSchema>;

export const stackRollbackRequestSchema = z.object({
  sourceDeploymentId: z.uuid("Choose a deployment."),
  stackId: z.uuid("Choose a stack."),
});

export type StackRollbackRequest = z.infer<typeof stackRollbackRequestSchema>;

export const deleteStackSchema = z.object({
  confirmName: z
    .string()
    .min(1, "Type the stack name to confirm.")
    .max(48, "Keep the name under 48 characters."),
  stackId: z.uuid("Choose a stack."),
});

export type DeleteStackRequest = z.infer<typeof deleteStackSchema>;
