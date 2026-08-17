import { z } from "zod";

export const envVarKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(
    /^[A-Za-z_][A-Za-z0-9_]*$/,
    "expected a shell identifier: letters, digits and _, cannot start with a digit"
  );

export const envVarInputSchema = z.object({
  isSecret: z.boolean().default(false),
  key: envVarKeySchema,
  // A value can legitimately be empty, and contain anything. It's
  // `execArgv` that makes it harmless, not this validation.
  value: z.string().max(65_536),
});

export type EnvVarInput = z.infer<typeof envVarInputSchema>;
