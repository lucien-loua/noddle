import { z } from "zod";

import { REGISTRY_HOST } from "./common.ts";

export const registrySchema = z.object({
  id: z.uuid("Choose a registry.").optional(),
  imagePrefix: z
    .string()
    .max(128, "Keep the prefix under 128 characters.")
    .default(""),
  name: z
    .string()
    .min(1, "Give this registry a name.")
    .max(64, "Keep the name under 64 characters."),
  password: z.string().max(256, "Keep the password under 256 characters."),
  registryUrl: z
    .string()
    .min(1, "Enter the registry host, such as ghcr.io.")
    .max(255, "Keep the host under 255 characters.")
    .refine(
      (v) => v === "" || REGISTRY_HOST.test(v),
      "Enter a hostname such as ghcr.io, without http:// or a path"
    ),
  username: z
    .string()
    .min(1, "The registry needs a username.")
    .max(128, "Keep the username under 128 characters."),
});

export const registryIdSchema = z.object({ id: z.uuid("Choose a registry.") });

export const serviceRegistrySchema = z.object({
  registryId: z.uuid("Choose a registry.").nullable(),
  serviceId: z.uuid("Choose a service."),
});

export type RegistryInput = z.infer<typeof registrySchema>;
