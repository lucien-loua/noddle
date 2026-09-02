import { z } from "zod";

export const projectNameSchema = z
  .string()
  .min(1, "Give this project a name.")
  .max(64, "Keep the name under 64 characters.");

export const environmentNameSchema = z
  .string()
  .min(1, "Give this environment a name.")
  .max(64, "Keep the name under 64 characters.");

export const createProjectSchema = z.object({
  description: z
    .string()
    .max(280, "Keep the description under 280 characters.")
    .optional(),
  environmentName: environmentNameSchema.default("production"),
  name: projectNameSchema,
});

export const renameProjectSchema = z.object({
  description: z
    .string()
    .max(280, "Keep the description under 280 characters.")
    .optional(),
  name: projectNameSchema,
  projectId: z.uuid("Choose a project."),
});

export const projectIdSchema = z.object({
  projectId: z.uuid("Choose a project."),
});

export const createEnvironmentSchema = z.object({
  description: z
    .string()
    .max(280, "Keep the description under 280 characters.")
    .optional(),
  name: environmentNameSchema,
  projectId: z.uuid("Choose a project."),
});

export const renameEnvironmentSchema = z.object({
  description: z
    .string()
    .max(280, "Keep the description under 280 characters.")
    .optional(),
  environmentId: z.uuid("Choose an environment."),
  name: environmentNameSchema,
});

export const environmentIdSchema = z.object({
  environmentId: z.uuid("Choose an environment."),
});

export const duplicateEnvironmentSchema = z.object({
  environmentId: z.uuid("Choose an environment."),
  name: environmentNameSchema,
});
