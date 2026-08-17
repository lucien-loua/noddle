import { z } from "zod";

/** Kept in sync with better-auth's `emailAndPassword` policy, which is set
 *  from these very constants — a client stricter than the server rejects a
 *  password the server would have taken, and the reverse lets a password
 *  through the form only to be refused by the API. */
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 128;

export const accountRoleNameSchema = z.enum(["owner", "admin", "deployer", "viewer"]);

/**
 * Sign-in does NOT re-apply the length policy: it only checks that something
 * was typed. Validating the format here would reject an existing password on
 * a rule that changed after it was set — the account would become
 * unreachable through a form that never explains why.
 */
export const signInSchema = z.object({
  email: z.email(),
  password: z.string().min(1, "Enter your password."),
});

/**
 * Sign-in and admin creation share one form, so the form carries all four
 * values whichever mode it is in — and a validator that ignored two of them
 * would not typecheck against it. The setup-only fields are therefore
 * present but unconstrained here; `signInSchema` stays the honest contract
 * for anything that actually signs in.
 */
export const signInFormSchema = signInSchema.extend({
  confirmPassword: z.string(),
  name: z.string(),
});

/**
 * The first account, created on a fresh install. It owns the installation and
 * there is no password reset, so the password is confirmed: a typo here locks
 * the owner out of their own server with nothing to fall back on.
 */
export const adminSetupSchema = z
  .object({
    confirmPassword: z.string().min(1, "Repeat the password."),
    email: z.email(),
    name: z.string().min(1, "Enter your name.").max(64, "Keep the name under 64 characters."),
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
  email: z.email(),
  name: z.string().min(1).max(64),
  role: accountRoleNameSchema,
});

export const accountRoleSchema = z.object({
  role: accountRoleNameSchema,
  userId: z.string().min(1),
});

/**
 * Deleting an account requires RETYPING ITS ADDRESS, like a service
 * requires its name. It's the product's most discreet action — a button
 * in a table row — and the only one nothing can be reconstructed from: the
 * audit log survives (`ON DELETE SET NULL` + denormalized `actor_email`),
 * but the account, its sessions and its password don't.
 *
 * It's the ADDRESS and not the name: two people can share a name, and
 * it's the address the row displays.
 *
 * `z.string()` and not `z.email()`: this field doesn't carry an address to
 * validate but an input to COMPARE. Validating it as an address would fail
 * a mistyped confirmation on a format error, where the only useful
 * response is "that doesn't match". The max follows the RFC 5321 limit.
 */
export const deleteAccountSchema = z.object({
  confirmEmail: z.string().min(1).max(254),
  userId: z.string().min(1),
});

export type DeleteAccountRequest = z.infer<typeof deleteAccountSchema>;
