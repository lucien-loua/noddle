import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const TOKEN_PREFIX = "noddle_pat_";
export const SECRET_LENGTH = 22;
export const CHECKSUM_LENGTH = 6;
export const DISPLAY_PREFIX_LENGTH = TOKEN_PREFIX.length + 4;

const ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const TOKEN_SHAPE = new RegExp(
  `^${TOKEN_PREFIX}([0-9A-Za-z]{${SECRET_LENGTH}})_([0-9A-Za-z]{${CHECKSUM_LENGTH}})$`
);

function base62(bytes: Buffer, length: number): string {
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += ALPHABET[(bytes[i] ?? 0) % ALPHABET.length];
  }
  return out;
}

function checksumOf(secret: string): string {
  const digest = createHash("sha256").update(`checksum:${secret}`).digest();
  return base62(digest, CHECKSUM_LENGTH);
}

export function generateToken(): string {
  const secret = base62(randomBytes(SECRET_LENGTH * 2), SECRET_LENGTH);
  return `${TOKEN_PREFIX}${secret}_${checksumOf(secret)}`;
}

export function isWellFormedToken(token: string): boolean {
  const parts = TOKEN_SHAPE.exec(token);
  const secret = parts?.[1];
  const given = parts?.[2];
  if (!(secret && given)) {
    return false;
  }
  const expected = Buffer.from(checksumOf(secret));
  const presented = Buffer.from(given);
  return (
    expected.length === presented.length && timingSafeEqual(expected, presented)
  );
}
