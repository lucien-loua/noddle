import { z } from "zod";

import { REGISTRY_HOST } from "./common.ts";

// The messages are WRITTEN, not left to Zod's default: "Too small:
// expected string to have >=1 characters" is developer text, and it
// surfaces as-is on both sides — under the field in the form, and in the
// error the server function returns. A single place to fix.
export const registrySchema = z.object({
  /** Absent = creation. Present = updating THIS registry. */
  id: z.uuid().optional(),
  imagePrefix: z
    .string()
    .max(128, "Keep the prefix under 128 characters.")
    .default(""),
  name: z
    .string()
    .min(1, "Give this registry a name.")
    .max(64, "Keep the name under 64 characters."),
  // Empty allowed, same reason as the S3 secret key: the password never
  // comes back from the server, so on an update an empty field means
  // "keep the one that's stored". It's the handler that requires it when
  // there's nothing to keep.
  password: z.string().max(256),
  // A HOST, not a URL: Docker expects `ghcr.io` or `host:5000`, never
  // `https://…`. A prefix stuck to an image would make it impossible to
  // pull.
  registryUrl: z
    .string()
    .min(1, "Enter the registry host, such as ghcr.io.")
    .max(255, "Keep the host under 255 characters.")
    // `v === ""` passes: the `min(1)` right above ALREADY rejected it,
    // and without this bailout an empty field carried TWO stacked
    // messages — "enter the host" then "without http://", the second of
    // which makes no sense on an empty value. Zod returns every issue
    // for a given field, it doesn't stop at the first one.
    .refine(
      (v) => v === "" || REGISTRY_HOST.test(v),
      "Enter a hostname such as ghcr.io, without http:// or a path"
    ),
  username: z
    .string()
    .min(1, "The registry needs a username.")
    .max(128, "Keep the username under 128 characters."),
});

export const registryIdSchema = z.object({ id: z.uuid() });

// `null` = the embedded registry. This is an explicit CHOICE, not an
// absence of value: the selector offers it as the first option.
export const serviceRegistrySchema = z.object({
  registryId: z.uuid().nullable(),
  serviceId: z.uuid(),
});

export type RegistryInput = z.infer<typeof registrySchema>;
