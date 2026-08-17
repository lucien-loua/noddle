/** 62 symbols: ~5.95 bits per character, so ~119 bits over 20. */
const CHARSET =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

const DEFAULT_LENGTH = 20;

/**
 * The largest multiple of 62 that fits in a byte.
 *
 * A byte drawn beyond it is REJECTED rather than folded via modulo:
 * without this, the first 8 characters of the set would come up slightly
 * more often than the others.
 */
const REJECT_ABOVE = Math.floor(256 / CHARSET.length) * CHARSET.length;

export function generateDatabasePassword(length = DEFAULT_LENGTH): string {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("no cryptographic random source available");
  }

  let out = "";
  // Drawn in batches: roughly 1 byte in 128 is rejected, so a single pass
  // is almost always enough, but the loop makes no assumption about that.
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
