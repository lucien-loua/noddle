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
  formatTestDomain,
  generateTestDomain,
  slugServerHost,
} from "#generate-domain";
import {
  backupCronSchema,
  bucketNameSchema,
  createBackupConfigSchema,
  objectPrefixSchema,
  s3DestinationCreateSchema,
  s3DestinationSchema,
} from "#validation/backup";
import {
  addDatabaseMountSchema,
  databaseConfigurationSchema,
  databaseReplicasSchema,
  imageRefSchema,
  setDatabaseSwarmSettingsSchema,
} from "#validation/database";
import { envVarKeySchema } from "#validation/env-var";
import { gitBranchSchema, serviceNameSchema } from "#validation/service";
import { expectThrows, ko, ok, runVerify, suite } from "#verify-harness";

const isCrypto = (e: unknown) => e instanceof CryptoError;
const mustThrow = (label: string, fn: () => unknown) =>
  expectThrows(label, fn, isCrypto);
const GENERATED_TEST_DOMAIN_PATTERN = /^api-[a-f0-9]{6}-10-0-0-1\.sslip\.io$/;

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

function verifyNameSchemas(): void {
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
}

function verifyDatabaseSchemas(): void {
  const imageOk = [
    "postgres:17-alpine",
    "ghcr.io/org/db:1.2.3",
    "redis@sha256:abcdef0123456789",
  ];
  const imageKo = ["", "postgres 17", "postgres:17'", "a".repeat(201)];
  if (
    imageOk.every((v) => imageRefSchema.safeParse(v).success) &&
    imageKo.every((v) => !imageRefSchema.safeParse(v).success) &&
    databaseConfigurationSchema.safeParse({
      databaseId: "00000000-0000-4000-8000-000000000001",
      image: "postgres:17-alpine",
    }).success &&
    !databaseConfigurationSchema.safeParse({
      databaseId: "not-a-uuid",
      image: "postgres:17-alpine",
    }).success
  ) {
    ok("databaseConfigurationSchema accepts a valid image update");
  } else {
    ko("inconsistent databaseConfigurationSchema");
  }

  if (
    databaseReplicasSchema.safeParse({
      databaseId: "00000000-0000-4000-8000-000000000001",
      replicas: 1,
    }).success &&
    !databaseReplicasSchema.safeParse({
      databaseId: "00000000-0000-4000-8000-000000000001",
      replicas: 0,
    }).success &&
    addDatabaseMountSchema.safeParse({
      databaseId: "00000000-0000-4000-8000-000000000001",
      source: "my-vol",
      target: "/var/lib/extra",
      type: "volume",
    }).success &&
    !addDatabaseMountSchema.safeParse({
      databaseId: "00000000-0000-4000-8000-000000000001",
      source: "my-vol",
      target: "relative",
      type: "volume",
    }).success &&
    setDatabaseSwarmSettingsSchema.safeParse({
      databaseId: "00000000-0000-4000-8000-000000000001",
      swarmSettings: {
        restartPolicy: { Condition: "on-failure", MaxAttempts: 3 },
      },
    }).success
  ) {
    ok("database cluster/volume schemas accept and reject correctly");
  } else {
    ko("inconsistent database cluster/volume schemas");
  }
}

function verifyS3BucketAndCron(): void {
  const bucketCases: [string, boolean][] = [
    ["noddle-sauvegardes", true],
    ["a.b.c", true],
    ["ab", false],
    ["Noddle", false],
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

  if (backupCronSchema.safeParse("0 0 * * *").success) {
    ok("backupCronSchema accepts a five-field cron");
  } else {
    ko("backupCronSchema rejected a valid cron");
  }

  if (backupCronSchema.safeParse("daily").success) {
    ko("backupCronSchema accepts a non-cron token");
  } else {
    ok("backupCronSchema rejects non-cron schedules");
  }

  const cfg = createBackupConfigSchema.safeParse({
    databaseId: "11111111-1111-4111-8111-111111111111",
    databaseName: "shop",
    destinationId: "22222222-2222-4222-8222-222222222222",
    enabled: true,
    keepLatestCount: 7,
    prefix: "nightly",
    schedule: "0 0 * * *",
  });
  if (cfg.success) {
    ok("createBackupConfigSchema accepts a valid schedule config");
  } else {
    ko(`createBackupConfigSchema failed: ${JSON.stringify(cfg.error.issues)}`);
  }
}

function verifyS3Destination(): void {
  const destination = s3DestinationSchema.safeParse({
    accessKeyId: "rustfsadmin",
    bucket: "noddle-sauvegardes",
    endpoint: "http://localhost:9000",
    name: "Principale",
    secretAccessKey: "rustfsadmin",
  });

  // An EMPTY secret is accepted by the schema — "keep the one that's
  // stored". It's the handler that requires a key when there's nothing to
  // keep, since only it knows whether a row exists.
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
  } catch (e) {
    if (e instanceof Error && e.message === "domain required msg") {
      ok("resolveRetainedSecret uses the caller requiredError");
    } else {
      ko(`resolveRetainedSecret wrong error: ${e}`);
    }
  }
}

function verifyGenerateDomain(): void {
  if (slugServerHost("192.168.1.10") === "192-168-1-10") {
    ok("slugServerHost dots become dashes");
  } else {
    ko("slugServerHost dots");
  }

  if (slugServerHost("2001:db8::1") === "2001-db8--1") {
    ok("slugServerHost colons become dashes");
  } else {
    ko("slugServerHost colons");
  }

  const domain = formatTestDomain({
    appName: "hello",
    hash: "abc123",
    serverHost: "192.168.252.3",
  });
  if (domain === "hello-abc123-192-168-252-3.sslip.io") {
    ok("formatTestDomain builds sslip.io hostname");
  } else {
    ko(`formatTestDomain: ${domain}`);
  }

  const generated = generateTestDomain({
    appName: "api",
    serverHost: "10.0.0.1",
  });
  if (GENERATED_TEST_DOMAIN_PATTERN.test(generated)) {
    ok("generateTestDomain randomizes hash segment");
  } else {
    ko(`generateTestDomain: ${generated}`);
  }
}

await runVerify("shared crypto + validation", async () => {
  await suite("crypto", verifyCrypto);
  await suite("name schemas", verifyNameSchemas);
  await suite("database schemas", verifyDatabaseSchemas);
  await suite("s3 bucket and cron", verifyS3BucketAndCron);
  await suite("s3 destination", verifyS3Destination);
  await suite("secret retention", verifySecretRetention);
  await suite("generate domain", verifyGenerateDomain);
});
