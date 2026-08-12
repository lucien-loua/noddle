//   bun  run packages/shared/src/verify.ts
//   node packages/shared/src/verify.ts
import { ko, ok, runVerify, suite } from "@noddle/testing";
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

const GENERATED_TEST_DOMAIN_PATTERN = /^api-[a-f0-9]{6}-10-0-0-1\.sslip\.io$/;

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

await runVerify("shared validation", async () => {
  await suite("name schemas", verifyNameSchemas);
  await suite("database schemas", verifyDatabaseSchemas);
  await suite("s3 bucket and cron", verifyS3BucketAndCron);
  await suite("s3 destination", verifyS3Destination);
  await suite("generate domain", verifyGenerateDomain);
});
