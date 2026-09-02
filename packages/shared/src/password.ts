const CHARSET =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

const DEFAULT_LENGTH = 20;

const REJECT_ABOVE = Math.floor(256 / CHARSET.length) * CHARSET.length;

export function generateDatabasePassword(length = DEFAULT_LENGTH): string {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("no cryptographic random source available");
  }

  let out = "";
  while (out.length < length) {
    const bytes = new Uint8Array(length - out.length);
    globalThis.crypto.getRandomValues(bytes);
    for (const b of bytes) {
      if (b < REJECT_ABOVE) {
        out += CHARSET[b % CHARSET.length];
      }
    }
  }
  return out;
}
