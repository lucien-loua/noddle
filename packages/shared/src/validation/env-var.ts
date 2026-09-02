import { z } from "zod";

export const envVarKeySchema = z
  .string()
  .min(1, "Enter a variable name.")
  .max(128, "Keep the name under 128 characters.")
  .regex(
    /^[A-Za-z_][A-Za-z0-9_]*$/,
    "expected a shell identifier: letters, digits and _, cannot start with a digit"
  );

export const envVarInputSchema = z.object({
  isSecret: z.boolean().default(false),
  key: envVarKeySchema,
  value: z.string().max(65_536, "Keep the value under 65536 characters."),
});

export type EnvVarInput = z.infer<typeof envVarInputSchema>;
