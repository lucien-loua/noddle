import { z } from "zod";

export const sshPrivateKeySchema = z
  .string()
  .min(1, "key required")
  .refine(
    (v) => v.includes("-----BEGIN") && v.includes("PRIVATE KEY"),
    "not a PEM private key: make sure you didn't paste the public key (.pub) instead"
  );

export const serverInputSchema = z.object({
  host: z
    .string()
    .min(1, "Enter the server address.")
    .max(255, "Keep the address under 255 characters."),
  name: z
    .string()
    .min(1, "Give this server a name.")
    .max(64, "Keep the name under 64 characters."),
  sshKeyId: z.uuid("Choose an SSH key."),
  sshPort: z
    .number({ error: "Enter a port number." })
    .int("Enter a whole port number.")
    .min(1, "Ports start at 1.")
    .max(65_535, "Ports stop at 65535.")
    .default(22),
  sshUser: z
    .string()
    .min(1, "Enter the SSH user, such as root.")
    .max(32, "Keep the user under 32 characters."),
});

export type ServerInput = z.infer<typeof serverInputSchema>;

export const sshKeyInputSchema = z.discriminatedUnion(
  "mode",
  [
    z.object({
      mode: z.literal("generate"),
      name: z
        .string()
        .min(1, "Give this key a name.")
        .max(64, "Keep the name under 64 characters."),
      type: z.enum(["ed25519", "rsa"], "Choose a key type.").default("ed25519"),
    }),
    z.object({
      mode: z.literal("import"),
      name: z
        .string()
        .min(1, "Give this key a name.")
        .max(64, "Keep the name under 64 characters."),
      privateKey: sshPrivateKeySchema,
    }),
  ],
  "Choose whether to generate or import a key."
);

export type SshKeyInput = z.infer<typeof sshKeyInputSchema>;

export const deleteSshKeySchema = z.object({
  sshKeyId: z.uuid("Choose an SSH key."),
});

export const deleteServerSchema = z.object({
  confirmName: z
    .string()
    .min(1, "Type the server name to confirm.")
    .max(64, "Keep the name under 64 characters."),
  serverId: z.uuid("Choose a server."),
});

export type DeleteServerRequest = z.infer<typeof deleteServerSchema>;
