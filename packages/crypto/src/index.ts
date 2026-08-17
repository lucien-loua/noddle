import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12; // 96 bits, the recommended size for GCM
const TAG_BYTES = 16;

/** Version prefix: allows changing algorithm without breaking existing data. */
const VERSION = "v1";

export class CryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CryptoError";
  }
}

/**
 * Loads and validates APP_KEY.
 *
 * Generate with:  openssl rand -base64 32
 *
 * Fails loudly rather than silently deriving a weak key from a string
 * that's too short: a malformed key must prevent startup, not produce
 * secrets that can't be decrypted.
 */
export function loadAppKey(raw: string | undefined): Buffer {
  if (!raw) {
    throw new CryptoError("APP_KEY is missing. Generate one with: openssl rand -base64 32");
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== KEY_BYTES) {
    throw new CryptoError(
      `APP_KEY must be ${KEY_BYTES} bytes once base64-decoded, got ${key.length}. Generate one with: openssl rand -base64 32`,
    );
  }
  return key;
}

/**
 * `aad` binds the ciphertext to its location (e.g. `env_var:<id>`).
 *
 * Without this binding, someone with write access to the database could
 * copy a server's encrypted SSH key into an environment variable's value,
 * then read it in plaintext through the UI. With it, decryption fails: the
 * context is part of what's authenticated.
 */
export interface SecretContext {
  aad: string;
}

export function encryptSecret(plaintext: string, key: Buffer, ctx: SecretContext): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(ctx.aad, "utf-8"));

  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptSecret(payload: string, key: Buffer, ctx: SecretContext): string {
  const parts = payload.split(".");
  if (parts.length !== 4) {
    throw new CryptoError("malformed ciphertext");
  }
  const [version, ivB64, tagB64, ctB64] = parts as [string, string, string, string];
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
    // biome-ignore lint/style/useErrorCause: the cause is deliberately hidden
    throw new CryptoError("cannot decrypt: invalid key, context or data");
  }
}

/**
 * Constant-time comparison, for secrets we compare instead of decrypting —
 * webhook tokens, for example. `===` on a string stops at the first
 * differing byte and leaks the length of the matching prefix.
 */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf-8");
  const bufB = Buffer.from(b, "utf-8");
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * Derives a subkey independent from APP_KEY.
 *
 * Avoids adding a second secret to manage in the installer: better-auth
 * needs its own, and giving it one via HKDF keeps a single root to back
 * up. The subkeys are independent — knowing better-auth's gives nothing
 * about the encrypted SSH keys.
 *
 * No salt: APP_KEY is already 32 uniformly random bytes, not a password.
 * It's `info` that separates the uses.
 */
export function deriveSubkey(key: Buffer, info: string): Buffer {
  return Buffer.from(hkdfSync("sha256", key, new Uint8Array(0), info, KEY_BYTES));
}

/** Incoming secret from a form: omitted or empty means "keep stored". */
export type SecretInput = string | null | undefined;

export function isRetainedSecret(input: SecretInput): input is null | undefined | "" {
  return input === null || input === undefined || input === "";
}

export async function resolveRetainedSecret(
  input: SecretInput,
  loadExisting: () => Promise<string | null | undefined>,
  requiredError: string,
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

/** Normalized AAD contexts. Building them elsewhere invites inconsistency. */
export const secretContext = {
  /** The backup destination's S3 secret key. */
  backupDestination: (destinationId: string): SecretContext => ({
    aad: `backup_destination:${destinationId}`,
  }),
  databasePassword: (databaseId: string): SecretContext => ({
    aad: `database_password:${databaseId}`,
  }),
  envVar: (envVarId: string): SecretContext => ({ aad: `env_var:${envVarId}` }),
  /**
   * The private key of a library entry.
   *
   * **The string always says `server_ssh_key` even though the key no longer
   * lives on `servers`, and that's deliberate.** The AAD is AUTHENTICATED:
   * renaming it would make every already-stored key undecryptable, with
   * nothing to signal it before the first connection attempt. The
   * migration in fact creates each `ssh_keys` row with the identifier of
   * the server it came from, precisely so that the ciphertext from before
   * keeps opening without being rewritten — something a SQL migration
   * couldn't do, lacking APP_KEY and AES-GCM.
   *
   * A context name is a data identifier, not a label. Same reason as
   * `backup_destination`, kept when the table was renamed to
   * `s3_destinations`.
   */
  /** Every secret of one connected forge, distinguished by field. */
  gitProvider: (gitProviderId: string, field: string): SecretContext => ({
    aad: `git_provider:${gitProviderId}:${field}`,
  }),
  /** A channel's URL: whoever holds it can post to the channel. */
  notificationChannel: (channelId: string): SecretContext => ({
    aad: `notification_channel:${channelId}`,
  }),
  /** An external registry's password. */
  registry: (registryId: string): SecretContext => ({
    aad: `registry:${registryId}`,
  }),
  sshKey: (sshKeyId: string): SecretContext => ({
    aad: `server_ssh_key:${sshKeyId}`,
  }),
  // A service or a stack — the id is enough to bind the ciphertext to ITS
  // row, a collision between the two tables being out of reach for a uuid
  // v4.
  webhookSecret: (ownerId: string): SecretContext => ({
    aad: `webhook_secret:${ownerId}`,
  }),
} as const;
