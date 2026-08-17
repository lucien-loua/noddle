import { z } from "zod";

export const sshPrivateKeySchema = z
  .string()
  .min(1, "key required")
  .refine(
    (v) => v.includes("-----BEGIN") && v.includes("PRIVATE KEY"),
    "not a PEM private key — make sure you didn't paste the public key (.pub) instead",
  );

export const serverInputSchema = z.object({
  host: z.string().min(1).max(255),
  name: z.string().min(1).max(64),
  // A CHOSEN key, not a pasted one: it comes from the library, where it
  // may have been created well before this form and already used by other
  // machines. This is the reversal of "paste a host and a key".
  sshKeyId: z.uuid(),
  sshPort: z.number().int().min(1).max(65_535).default(22),
  sshUser: z.string().min(1).max(32),
});

export type ServerInput = z.infer<typeof serverInputSchema>;

/**
 * Creating an entry: either paste a key, or ask Noddle to generate one.
 *
 * Generating is the path we prefer, and not for convenience: the private
 * key then NEVER exists anywhere except encrypted in the database — it
 * never passes through a clipboard, a password manager or a terminal's
 * history. Pasting stays available because an already-provisioned machine
 * often has an imposed key.
 */
export const sshKeyInputSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("generate"),
    name: z.string().min(1).max(64),
    // ed25519 by default; RSA stays available for systems that still
    // refuse ed25519. Absent from the "import" branch: a pasted key
    // already has its type, asking again would let the two diverge.
    type: z.enum(["ed25519", "rsa"]).default("ed25519"),
  }),
  z.object({
    mode: z.literal("import"),
    name: z.string().min(1).max(64),
    privateKey: sshPrivateKeySchema,
  }),
]);

export type SshKeyInput = z.infer<typeof sshKeyInputSchema>;

export const deleteSshKeySchema = z.object({ sshKeyId: z.uuid() });

/**
 * Deleting a stack, a database, a server.
 *
 * All three require RETYPING THE NAME, like a service and like a restore.
 * This isn't UI politeness: the name is re-checked server-side, because a
 * dialog only protects clients that display it.
 *
 * `max(64)` and not 48: a server name follows `serverInputSchema`, wider
 * than `serviceNameSchema`.
 */
export const deleteServerSchema = z.object({
  confirmName: z.string().min(1).max(64),
  serverId: z.uuid(),
});

export type DeleteServerRequest = z.infer<typeof deleteServerSchema>;
