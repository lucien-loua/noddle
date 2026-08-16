// tier: pure
//   bun  run packages/shared/src/verify.ts
//   node packages/shared/src/verify.ts
import { ko, ok, runVerify, suite } from "@noddle/testing";
import {
  formatTestDomain,
  generateTestDomain,
  slugServerHost,
} from "#generate-domain";
import { adminSetupSchema, signInSchema } from "#validation/account";
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
import {
  buildPathSchema,
  dockerImageSchema,
  gitBranchSchema,
  isGitSourceType,
  serviceDockerProviderSchema,
  serviceGitProviderSchema,
  serviceNameSchema,
} from "#validation/service";

const GENERATED_TEST_DOMAIN_PATTERN = /^api-[a-f0-9]{6}-10-0-0-1\.sslip\.io$/;

function verifyAccountSchemas(): void {
  const admin = {
    confirmPassword: "correct horse",
    email: "admin@example.com",
    name: "Jane Doe",
    password: "correct horse",
  };

  if (adminSetupSchema.safeParse(admin).success) {
    ok("adminSetupSchema accepts a complete admin");
  } else {
    ko("adminSetupSchema rejects a valid admin");
  }

  // The mismatch must be reported ON the confirmation field. Attached
  // anywhere else, the form refuses to submit while showing nothing — the
  // owner is locked out of a screen that never says why.
  const mismatch = adminSetupSchema.safeParse({
    ...admin,
    confirmPassword: "correct hoarse",
  });
  if (
    !mismatch.success &&
    mismatch.error.issues.some((issue) => issue.path[0] === "confirmPassword")
  ) {
    ok("adminSetupSchema reports a mismatch on confirmPassword");
  } else {
    ko("adminSetupSchema: mismatch not reported on confirmPassword");
  }

  if (
    adminSetupSchema.safeParse({
      ...admin,
      confirmPassword: "short",
      password: "short",
    }).success
  ) {
    ko("adminSetupSchema accepts a password below the minimum");
  } else {
    ok("adminSetupSchema enforces the minimum length");
  }

  // Sign-in deliberately does NOT re-apply that policy.
  if (
    signInSchema.safeParse({ email: "admin@example.com", password: "short" })
      .success
  ) {
    ok("signInSchema accepts any non-empty password");
  } else {
    ko("signInSchema applies a length rule it should not");
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

  // The build path becomes a `cd` target on the user's server. The path
  // regex alone accepts `..` as a segment, so the refusal is explicit.
  if (
    buildPathSchema.safeParse("").success &&
    buildPathSchema.safeParse("apps/web").success &&
    !buildPathSchema.safeParse("../../etc").success &&
    !buildPathSchema.safeParse("apps/../../etc").success &&
    !buildPathSchema.safeParse("/absolute").success
  ) {
    ok("buildPathSchema refuses anything leaving the repository");
  } else {
    ko("inconsistent buildPathSchema");
  }

  if (
    serviceGitProviderSchema.safeParse({
      buildPath: "",
      deployKeyId: null,
      gitBranch: "main",
      gitProviderId: null,
      gitRepoFullName: null,
      gitRepoUrl: "https://github.com/org/repo.git",
      gitSubmodules: false,
      watchPaths: [],
    }).success &&
    serviceGitProviderSchema.safeParse({
      buildPath: "apps/web",
      deployKeyId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
      gitBranch: "main",
      gitProviderId: "3f2504e0-4f89-41d3-9a0c-0305e82c3302",
      gitRepoFullName: "org/repo",
      gitRepoUrl: "",
      gitSubmodules: true,
      watchPaths: ["apps/web/**"],
    }).success &&
    !serviceGitProviderSchema.safeParse({
      buildPath: "",
      deployKeyId: null,
      gitBranch: "main",
      gitProviderId: null,
      gitRepoFullName: null,
      gitRepoUrl: "not-a-url",
      gitSubmodules: false,
      watchPaths: [],
    }).success &&
    // The clone flag is carried by the form, never inferred: a missing field
    // would silently deploy without submodules.
    !serviceGitProviderSchema.safeParse({
      gitBranch: "main",
      gitRepoUrl: "https://github.com/org/repo.git",
    }).success
  ) {
    ok("serviceGitProviderSchema accepts a URL or an empty field");
  } else {
    ko("inconsistent serviceGitProviderSchema");
  }

  const builtInRegistry = {
    registryChoice: "",
    registryName: "",
    registryPassword: "",
    registryUrl: "",
    registryUsername: "",
  };
  if (
    dockerImageSchema.safeParse("nginx:alpine").success &&
    dockerImageSchema.safeParse("ghcr.io/org/app:1.2.3").success &&
    !dockerImageSchema.safeParse("nginx alpine").success &&
    serviceDockerProviderSchema.safeParse({
      ...builtInRegistry,
      dockerImage: "",
    }).success &&
    serviceDockerProviderSchema.safeParse({
      ...builtInRegistry,
      dockerImage: "nginx:alpine",
    }).success &&
    // The registry fields are only validated while creating one, so the
    // built-in choice must not drag a half-filled credentials form with it.
    !serviceDockerProviderSchema.safeParse({
      ...builtInRegistry,
      dockerImage: "nginx:alpine",
      registryChoice: "new",
    }).success
  ) {
    ok("serviceDockerProviderSchema accepts a published image or empty");
  } else {
    ko("inconsistent serviceDockerProviderSchema");
  }

  if (
    isGitSourceType("git") &&
    isGitSourceType("github") &&
    isGitSourceType("gitlab") &&
    !isGitSourceType("docker_image")
  ) {
    ok("isGitSourceType distinguishes git remotes from a published image");
  } else {
    ko("inconsistent isGitSourceType");
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
  await suite("account schemas", verifyAccountSchemas);
  await suite("name schemas", verifyNameSchemas);
  await suite("database schemas", verifyDatabaseSchemas);
  await suite("s3 bucket and cron", verifyS3BucketAndCron);
  await suite("s3 destination", verifyS3Destination);
  await suite("generate domain", verifyGenerateDomain);
});
