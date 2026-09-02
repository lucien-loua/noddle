import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

const VERSION = "v1";

export class CryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CryptoError";
  }
}

export function loadAppKey(raw: string | undefined): Buffer {
  if (!raw) {
    throw new CryptoError(
      "APP_KEY is missing. Generate one with: openssl rand -base64 32"
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== KEY_BYTES) {
    throw new CryptoError(
      `APP_KEY must be ${KEY_BYTES} bytes once base64-decoded, got ${key.length}. Generate one with: openssl rand -base64 32`
    );
  }
  return key;
}

export interface SecretContext {
  aad: string;
}

export function encryptSecret(
  plaintext: string,
  key: Buffer,
  ctx: SecretContext
): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(ctx.aad, "utf-8"));

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf-8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptSecret(
  payload: string,
  key: Buffer,
  ctx: SecretContext
): string {
  const parts = payload.split(".");
  if (parts.length !== 4) {
    throw new CryptoError("malformed ciphertext");
  }
  const [version, ivB64, tagB64, ctB64] = parts as [
    string,
    string,
    string,
    string,
  ];
  if (version !== VERSION) {
    throw new CryptoError(`unknown encryption version: ${version}`);
  }

  const iv = Buffer.from(ivB64, "base64url");
  const tag = Buffer.from(tagB64, "base64url");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new CryptoError("IV or authentication tag has the wrong size");
  }

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAAD(Buffer.from(ctx.aad, "utf-8"));
  decipher.setAuthTag(tag);

  try {
    return Buffer.concat([
      decipher.update(Buffer.from(ctB64, "base64url")),
      decipher.final(),
    ]).toString("utf-8");
  } catch {
    throw new CryptoError("cannot decrypt: invalid key, context or data");
  }
}

export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf-8");
  const bufB = Buffer.from(b, "utf-8");
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export function deriveSubkey(key: Buffer, info: string): Buffer {
  return Buffer.from(
    hkdfSync("sha256", key, new Uint8Array(0), info, KEY_BYTES)
  );
}

export type SecretInput = string | null | undefined;

export function isRetainedSecret(
  input: SecretInput
): input is null | undefined | "" {
  return input === null || input === undefined || input === "";
}

export async function resolveRetainedSecret(
  input: SecretInput,
  loadExisting: () => Promise<string | null | undefined>,
  requiredError: string
): Promise<string> {
  if (!isRetainedSecret(input)) {
    return input;
  }
  const existing = await loadExisting();
  if (isRetainedSecret(existing)) {
    throw new Error(requiredError);
  }
  return existing;
}

export const secretContext = {
  backupDestination: (destinationId: string): SecretContext => ({
    aad: `backup_destination:${destinationId}`,
  }),
  databasePassword: (databaseId: string): SecretContext => ({
    aad: `database_password:${databaseId}`,
  }),
  envVar: (envVarId: string): SecretContext => ({ aad: `env_var:${envVarId}` }),
  gitProvider: (gitProviderId: string, field: string): SecretContext => ({
    aad: `git_provider:${gitProviderId}:${field}`,
  }),
  notificationChannel: (channelId: string): SecretContext => ({
    aad: `notification_channel:${channelId}`,
  }),
  registry: (registryId: string): SecretContext => ({
    aad: `registry:${registryId}`,
  }),
  sshKey: (sshKeyId: string): SecretContext => ({
    aad: `server_ssh_key:${sshKeyId}`,
  }),
  webhookSecret: (ownerId: string): SecretContext => ({
    aad: `webhook_secret:${ownerId}`,
  }),
} as const;
