import { z } from "zod";

/**
 * A simple organizational label, never a Docker or Traefik identifier —
 * unlike a service name, it therefore doesn't need to be lowercase nor
 * follow hostname constraints.
 */
export const projectNameSchema = z.string().min(1).max(64);
export const environmentNameSchema = z.string().min(1).max(64);

export const createProjectSchema = z.object({
  description: z.string().max(280).optional(),
  /** The first environment, created WITH the project. A project with no
   *  environment is unreachable from any screen — `/projects/<id>`
   *  redirects to the first one and wouldn't find any. */
  environmentName: environmentNameSchema.default("production"),
  name: projectNameSchema,
});

export const renameProjectSchema = z.object({
  description: z.string().max(280).optional(),
  name: projectNameSchema,
  projectId: z.uuid(),
});

export const projectIdSchema = z.object({ projectId: z.uuid() });

export const createEnvironmentSchema = z.object({
  description: z.string().max(280).optional(),
  name: environmentNameSchema,
  projectId: z.uuid(),
});

export const renameEnvironmentSchema = z.object({
  description: z.string().max(280).optional(),
  environmentId: z.uuid(),
  name: environmentNameSchema,
});

export const environmentIdSchema = z.object({ environmentId: z.uuid() });

export const duplicateEnvironmentSchema = z.object({
  environmentId: z.uuid(),
  name: environmentNameSchema,
});
