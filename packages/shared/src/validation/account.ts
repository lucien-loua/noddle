import { z } from "zod";

export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 128;

export const accountRoleNameSchema = z.enum(
  ["owner", "admin", "deployer", "viewer"],
  "Choose a role."
);

export const signInSchema = z.object({
  email: z.email("Enter an email address, such as you@example.com."),
  password: z.string().min(1, "Enter your password."),
});

export const signInFormSchema = signInSchema.extend({
  confirmPassword: z.string(),
  name: z.string(),
});

export const adminSetupSchema = z
  .object({
    confirmPassword: z.string().min(1, "Repeat the password."),
    email: z.email("Enter an email address, such as you@example.com."),
    name: z
      .string()
      .min(1, "Enter your name.")
      .max(64, "Keep the name under 64 characters."),
    password: z
      .string()
      .min(MIN_PASSWORD_LENGTH, `At least ${MIN_PASSWORD_LENGTH} characters.`)
      .max(MAX_PASSWORD_LENGTH, `At most ${MAX_PASSWORD_LENGTH} characters.`),
  })
  .refine((v) => v.password === v.confirmPassword, {
    message: "Both passwords must match.",
    path: ["confirmPassword"],
  });

export type AdminSetupRequest = z.infer<typeof adminSetupSchema>;

export const createAccountSchema = z.object({
  email: z.email("Enter an email address, such as you@example.com."),
  name: z
    .string()
    .min(1, "Enter the person's name.")
    .max(64, "Keep the name under 64 characters."),
  role: accountRoleNameSchema,
});

export const accountRoleSchema = z.object({
  role: accountRoleNameSchema,
  userId: z.string().min(1, "Choose an account."),
});

export const deleteAccountSchema = z.object({
  confirmEmail: z
    .string()
    .min(1, "Type the email address to confirm.")
    .max(254, "Keep the email address under 254 characters."),
  userId: z.string().min(1, "Choose an account."),
});

export type DeleteAccountRequest = z.infer<typeof deleteAccountSchema>;
