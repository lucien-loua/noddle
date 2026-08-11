import { z } from "zod";

export const accountRoleNameSchema = z.enum([
  "owner",
  "admin",
  "deployer",
  "viewer",
]);

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
