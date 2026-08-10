//   bun  run packages/shared/src/verify.ts
//   node packages/shared/src/verify.ts
import { randomBytes } from "node:crypto";
import {
  CryptoError,
  decryptSecret,
  encryptSecret,
  isRetainedSecret,
  loadAppKey,
  resolveRetainedSecret,
  safeEqual,
  secretContext,
} from "#crypto";
import {
  bucketNameSchema,
  envVarKeySchema,
  gitBranchSchema,
  objectPrefixSchema,
  s3DestinationCreateSchema,
  s3DestinationSchema,
  serviceNameSchema,
} from "#validation";

const runtime =
  typeof (globalThis as { Bun?: unknown }).Bun === "undefined"
    ? `Node ${process.version}`
    : `Bun ${(globalThis as { Bun: { version: string } }).Bun.version}`;

let pass = 0;
let fail = 0;
const ok = (m: string) => {
  pass += 1;
  console.log(`  \x1b[32m?\x1b[0m ${m}`);
};
const ko = (m: string) => {
  fail += 1;
  console.log(`  \x1b[31m?\x1b[0m ${m}`);
};

/** Expects a failure. A test that passes silently is a test that lies. */
function mustThrow(label: string, fn: () => unknown) {
  try {
    fn();
    ko(`${label} — SHOULD HAVE FAILED`);
  } catch (e) {
    if (e instanceof CryptoError) {
      ok(label);
    } else {
      ko(`${label} — wrong error: ${e instanceof Error ? e.message : e}`);
    }
  }
}

console.log(`\n\x1b[1m${runtime}\x1b[0m\n`);

const KEY = randomBytes(32);
const OTHER_KEY = randomBytes(32);
const ctx = secretContext.sshKey("srv-1");
const SECRET = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END-----";

// ?? key ?????????????????????????????????????????????????????????????????????
mustThrow("missing APP_KEY is rejected", () => loadAppKey(undefined));
mustThrow("too-short APP_KEY is rejected", () =>
  loadAppKey(Buffer.from("court").toString("base64"))
);
if (loadAppKey(KEY.toString("base64")).equals(KEY)) {
  ok("valid APP_KEY is accepted");
} else {
  ko("valid APP_KEY badly decoded");
}

// ?? round trip ????????????????????????????????????????????????????????????
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

// ?? non-determinism: unique IV on every encryption ??????????????????????????
// Reusing an IV in GCM is catastrophic — it breaks authentication.
const boxes = new Set(
  Array.from({ length: 200 }, () => encryptSecret(SECRET, KEY, ctx))
);
if (boxes.size === 200) {
  ok("200 encryptions of the same plaintext ? 200 distinct results");
} else {
  ko(`reused IV: ${200 - boxes.size} collision(s)`);
}

// ?? expected failures ????????????????????????????????????????????????????????
mustThrow("wrong key ? rejected", () => decryptSecret(box, OTHER_KEY, ctx));

mustThrow("wrong context ? rejected (AAD binding)", () =>
  decryptSecret(box, KEY, secretContext.sshKey("srv-2"))
);

mustThrow("ciphertext moved to another field ? rejected", () =>
  decryptSecret(box, KEY, secretContext.envVar("srv-1"))
);

const parts = box.split(".");
const flip = (s: string) => {
  const b = Buffer.from(s, "base64url");
  const idx = b.length - 1;
  // biome-ignore lint/suspicious/noBitwiseOperators: flipping a bit IS the test
  b[idx] = (b[idx] ?? 0) ^ 0x01;
  return b.toString("base64url");
};
mustThrow("altered ciphertext ? rejected", () =>
  decryptSecret(
    [parts[0], parts[1], parts[2], flip(parts[3] ?? "")].join("."),
    KEY,
    ctx
  )
);
mustThrow("altered auth tag ? rejected", () =>
  decryptSecret(
    [parts[0], parts[1], flip(parts[2] ?? ""), parts[3]].join("."),
    KEY,
    ctx
  )
);
mustThrow("unknown version ? rejected", () =>
  decryptSecret(["v2", parts[1], parts[2], parts[3]].join("."), KEY, ctx)
);
mustThrow("malformed format ? rejected", () =>
  decryptSecret("nawak", KEY, ctx)
);

// ?? constant-time comparison ?????????????????????????????????????????????????
if (
  safeEqual("token", "token") &&
  !safeEqual("token", "tokeX") &&
  !safeEqual("a", "ab")
) {
  ok("safeEqual");
} else {
  ko("incorrect safeEqual");
}

// ?? validation ????????????????????????????????????????????????????????????????
const cases: [string, boolean][] = [
  ["api", true],
  ["-api", false],
  ["API", false],
  ["mon service", false],
];
if (
  cases.every(([v, want]) => serviceNameSchema.safeParse(v).success === want)
) {
  ok("serviceNameSchema accepts and rejects what it should");
} else {
  ko("inconsistent serviceNameSchema");
}

if (
  gitBranchSchema.safeParse("main").success &&
  !gitBranchSchema.safeParse("a..b").success &&
  !gitBranchSchema.safeParse("feat branch").success
) {
  ok("gitBranchSchema rejects what git would reject");
} else {
  ko("inconsistent gitBranchSchema");
}

if (
  envVarKeySchema.safeParse("DATABASE_URL").success &&
  !envVarKeySchema.safeParse("1BAD").success &&
  !envVarKeySchema.safeParse("A-B").success
) {
  ok("envVarKeySchema enforces a shell identifier");
} else {
  ko("inconsistent envVarKeySchema");
}

// ?????????????????????????????????????????????????????????????????????????????
// S3 backups
// ?????????????????????????????????????????????????????????????????????????????

const bucketCases: [string, boolean][] = [
  ["noddle-sauvegardes", true],
  ["a.b.c", true],
  ["ab", false], // fewer than 3 characters, rejected by S3 itself
  ["Noddle", false], // an uppercase letter, rejected by S3 itself
  ["-noddle", false],
  ["noddle-", false],
];
if (
  bucketCases.every(
    ([v, want]) => bucketNameSchema.safeParse(v).success === want
  )
) {
  ok("bucketNameSchema applies AWS's naming rules");
} else {
  ko("inconsistent bucketNameSchema");
}

// The prefix is NORMALIZED, not just validated: without this,
// `sauvegardes/` and `sauvegardes` would produce two different key
// layouts for input the user believes to be identical.
const prefixed = objectPrefixSchema.safeParse("/sauvegardes/noddle/");
if (prefixed.success && prefixed.data === "sauvegardes/noddle") {
  ok("objectPrefixSchema normalizes leading/trailing slashes");
} else {
  ko(`objectPrefixSchema didn't normalize: ${JSON.stringify(prefixed)}`);
}

if (objectPrefixSchema.safeParse("a/../b").success) {
  ko("objectPrefixSchema accepts `..`");
} else {
  ok("objectPrefixSchema rejects `..`");
}

const destination = s3DestinationSchema.safeParse({
  accessKeyId: "rustfsadmin",
  bucket: "noddle-sauvegardes",
  endpoint: "http://localhost:9000",
  name: "Principale",
  secretAccessKey: "rustfsadmin",
});

// An EMPTY secret is accepted by the schema — "keep the one that's
// stored". It's the handler that requires a key when there's nothing to
// keep, since only it knows whether a row exists. The previous `min(1)`
// made the screen's promise ("Leave empty to keep the stored key")
// impossible to keep.
if (
  s3DestinationSchema.safeParse({
    accessKeyId: "rustfsadmin",
    bucket: "noddle-sauvegardes",
    endpoint: "http://localhost:9000",
    name: "Principale",
    secretAccessKey: "",
  }).success
) {
  ok("s3DestinationSchema accepts an empty secret (= keep the existing one)");
} else {
  ko("s3DestinationSchema rejects an empty secret");
}

if (
  s3DestinationCreateSchema.safeParse({
    accessKeyId: "rustfsadmin",
    bucket: "noddle-sauvegardes",
    endpoint: "http://localhost:9000",
    name: "Principale",
    secretAccessKey: "",
  }).success
) {
  ko("s3DestinationCreateSchema accepts an empty secret");
} else {
  ok("s3DestinationCreateSchema requires a secret");
}
if (
  destination.success &&
  destination.data.region === "us-east-1" &&
  destination.data.forcePathStyle &&
  destination.data.prefix === ""
) {
  ok("s3DestinationSchema applies its defaults");
} else {
  ko(`s3DestinationSchema: ${JSON.stringify(destination)}`);
}

// An endpoint with no scheme is the form's most likely input mistake —
// the SDK would fail much further along, on the first network call.
if (
  s3DestinationSchema.safeParse({
    accessKeyId: "k",
    bucket: "noddle-sauvegardes",
    endpoint: "localhost:9000",
    secretAccessKey: "s",
  }).success
) {
  ko("s3DestinationSchema accepts an endpoint with no scheme");
} else {
  ok("s3DestinationSchema rejects an endpoint without http(s)://");
}

// ?? secret retention ????????????????????????????????????????????????????????
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

{
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
  } catch (e) {
    if (e instanceof Error && e.message === "domain required msg") {
      ok("resolveRetainedSecret uses the caller requiredError");
    } else {
      ko(`resolveRetainedSecret wrong error: ${e}`);
    }
  }
}

console.log(`\n\x1b[1m${runtime} — passed ${pass}, failed ${fail}\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
