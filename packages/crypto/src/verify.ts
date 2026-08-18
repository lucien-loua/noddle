// tier: pure
// bun run packages/crypto/src/verify.ts
import { randomBytes } from "node:crypto";

import { expectThrows, ko, ok, runVerify, suite } from "@noddle/testing";

import {
  CryptoError,
  decryptSecret,
  encryptSecret,
  isRetainedSecret,
  loadAppKey,
  resolveRetainedSecret,
  safeEqual,
  secretContext,
} from "./index.ts";

const isCrypto = (e: unknown) => e instanceof CryptoError;
const mustThrow = (label: string, fn: () => unknown) =>
  expectThrows(label, fn, isCrypto);

function verifyCrypto(): void {
  const KEY = randomBytes(32);
  const OTHER_KEY = randomBytes(32);
  const ctx = secretContext.sshKey("srv-1");
  const SECRET = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END-----";

  mustThrow("missing APP_KEY is rejected", () => loadAppKey(undefined));
  mustThrow("too-short APP_KEY is rejected", () =>
    loadAppKey(Buffer.from("court").toString("base64"))
  );
  if (loadAppKey(KEY.toString("base64")).equals(KEY)) {
    ok("valid APP_KEY is accepted");
  } else {
    ko("valid APP_KEY badly decoded");
  }

  const box = encryptSecret(SECRET, KEY, ctx);
  if (decryptSecret(box, KEY, ctx) === SECRET) {
    ok("round trip");
  } else {
    ko("incorrect round trip");
  }
  if (box.includes("BEGIN")) {
    ko("plaintext leaks into the ciphertext");
  } else {
    ok("plaintext doesn't appear in the ciphertext");
  }

  // Reusing an IV in GCM is catastrophic — it breaks authentication.
  const boxes = new Set(
    Array.from({ length: 200 }, () => encryptSecret(SECRET, KEY, ctx))
  );
  if (boxes.size === 200) {
    ok("200 encryptions of the same plaintext → 200 distinct results");
  } else {
    ko(`reused IV: ${200 - boxes.size} collision(s)`);
  }

  mustThrow("wrong key → rejected", () => decryptSecret(box, OTHER_KEY, ctx));
  mustThrow("wrong context → rejected (AAD binding)", () =>
    decryptSecret(box, KEY, secretContext.sshKey("srv-2"))
  );
  mustThrow("ciphertext moved to another field → rejected", () =>
    decryptSecret(box, KEY, secretContext.envVar("srv-1"))
  );

  const parts = box.split(".");
  const flip = (s: string) => {
    const b = Buffer.from(s, "base64url");
    const idx = b.length - 1;
    // biome-ignore lint/suspicious/noBitwiseOperators: flipping a bit IS the test
    // oxlint-disable-next-line no-bitwise -- flipping one bit IS the tamper
    b[idx] = (b[idx] ?? 0) ^ 0x01;
    return b.toString("base64url");
  };
  mustThrow("altered ciphertext → rejected", () =>
    decryptSecret(
      [parts[0], parts[1], parts[2], flip(parts[3] ?? "")].join("."),
      KEY,
      ctx
    )
  );
  mustThrow("altered auth tag → rejected", () =>
    decryptSecret(
      [parts[0], parts[1], flip(parts[2] ?? ""), parts[3]].join("."),
      KEY,
      ctx
    )
  );
  mustThrow("unknown version → rejected", () =>
    decryptSecret(["v2", parts[1], parts[2], parts[3]].join("."), KEY, ctx)
  );
  mustThrow("malformed format → rejected", () =>
    decryptSecret("nawak", KEY, ctx)
  );

  if (
    safeEqual("token", "token") &&
    !safeEqual("token", "tokeX") &&
    !safeEqual("a", "ab")
  ) {
    ok("safeEqual");
  } else {
    ko("incorrect safeEqual");
  }
}

async function verifySecretRetention(): Promise<void> {
  if (
    isRetainedSecret(null) &&
    isRetainedSecret(undefined) &&
    isRetainedSecret("") &&
    !isRetainedSecret("s3cret")
  ) {
    ok('isRetainedSecret treats null/undefined/"" as retain');
  } else {
    ko("isRetainedSecret misclassified an input");
  }

  const kept = await resolveRetainedSecret(
    "",
    async () => "stored-secret",
    "a secret is required"
  );
  if (kept === "stored-secret") {
    ok("resolveRetainedSecret loads the stored secret when input is empty");
  } else {
    ko(`resolveRetainedSecret empty retain: ${kept}`);
  }

  const fresh = await resolveRetainedSecret(
    "new-secret",
    async () => "stored-secret",
    "a secret is required"
  );
  if (fresh === "new-secret") {
    ok("resolveRetainedSecret prefers a provided secret");
  } else {
    ko(`resolveRetainedSecret fresh: ${fresh}`);
  }

  try {
    await resolveRetainedSecret("", async () => null, "domain required msg");
    ko("resolveRetainedSecret should fail without a stored secret");
  } catch (error) {
    if (error instanceof Error && error.message === "domain required msg") {
      ok("resolveRetainedSecret uses the caller requiredError");
    } else {
      ko(`resolveRetainedSecret wrong error: ${error}`);
    }
  }
}

await runVerify("crypto", async () => {
  await suite("crypto", verifyCrypto);
  await suite("secret retention", verifySecretRetention);
});
