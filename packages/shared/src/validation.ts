import { z } from "zod";
import { DATABASE_ENGINES } from "#database-engines";

// Hoisted to module level: a regex rebuilt on every call gets recompiled
// on every validation.
const BRANCH_FORBIDDEN_CHARS = /[\s~^:?*[\\]/;
const GIT_SSH_URL = /^git@[\w.-]+:/;
const HTTPS_URL = /^https:\/\//;
const HTTP_OR_HTTPS_URL = /^https?:\/\//;
const LEADING_SLASHES = /^\/+/;
const REGISTRY_HOST = /^[a-z0-9][a-z0-9.-]*(:\d{1,5})?$/i;
const TRAILING_SLASHES = /\/+$/;

// ─────────────────────────────────────────────────────────────────────────────
// servers
// ─────────────────────────────────────────────────────────────────────────────

export const sshPrivateKeySchema = z
  .string()
  .min(1, "key required")
  .refine(
    (v) => v.includes("-----BEGIN") && v.includes("PRIVATE KEY"),
    "not a PEM private key — make sure you didn't paste the public key (.pub) instead"
  );

export const serverInputSchema = z.object({
  host: z.string().min(1).max(255),
  name: z.string().min(1).max(64),
  // A CHOSEN key, not a pasted one: it comes from the library, where it
  // may have been created well before this form and already used by other
  // machines. This is the reversal of "paste a host and a key".
  sshKeyId: z.uuid(),
  sshPort: z.number().int().min(1).max(65_535).default(22),
  sshUser: z.string().min(1).max(32),
});

export type ServerInput = z.infer<typeof serverInputSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// key library
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creating an entry: either paste a key, or ask Noddle to generate one.
 *
 * Generating is the path we prefer, and not for convenience: the private
 * key then NEVER exists anywhere except encrypted in the database — it
 * never passes through a clipboard, a password manager or a terminal's
 * history. Pasting stays available because an already-provisioned machine
 * often has an imposed key.
 */
export const sshKeyInputSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("generate"),
    name: z.string().min(1).max(64),
    // ed25519 by default; RSA stays available for systems that still
    // refuse ed25519. Absent from the "import" branch: a pasted key
    // already has its type, asking again would let the two diverge.
    type: z.enum(["ed25519", "rsa"]).default("ed25519"),
  }),
  z.object({
    mode: z.literal("import"),
    name: z.string().min(1).max(64),
    privateKey: sshPrivateKeySchema,
  }),
]);

export type SshKeyInput = z.infer<typeof sshKeyInputSchema>;

export const deleteSshKeySchema = z.object({ sshKeyId: z.uuid() });

// ─────────────────────────────────────────────────────────────────────────────
// projects / environments
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A simple organizational label, never a Docker or Traefik identifier —
 * unlike a service name, it therefore doesn't need to be lowercase nor
 * follow hostname constraints.
 */
export const projectNameSchema = z.string().min(1).max(64);
export const environmentNameSchema = z.string().min(1).max(64);

// ─────────────────────────────────────────────────────────────────────────────
// services
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The name becomes a Swarm service name and a Traefik router name. Neither
 * accepts just anything, and a rejected name must not be discovered at
 * deploy time.
 */
export const serviceNameSchema = z
  .string()
  .min(1)
  .max(48)
  .regex(
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/,
    "lowercase letters, digits and dashes; cannot start or end with a dash"
  );

export const gitRepoUrlSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (v) => HTTPS_URL.test(v) || GIT_SSH_URL.test(v),
    "expected an https:// URL or git@host:path"
  );

export const gitBranchSchema = z
  .string()
  .min(1)
  .max(255)
  // Git's own restrictions: no space, no `..`, no `~^:?*[`, no ending in
  // `.lock`. An invalid branch would make the clone fail.
  .refine(
    (v) => !BRANCH_FORBIDDEN_CHARS.test(v),
    "character not allowed in a branch name"
  )
  .refine((v) => !v.includes(".."), "`..` is not allowed in a branch name")
  .refine((v) => !v.endsWith(".lock"), "a branch name cannot end with .lock");

export const domainSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(
    /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/,
    "invalid domain name"
  );

export const serviceInputSchema = z.object({
  buildMethod: z.enum(["nixpacks", "dockerfile", "image"]).default("nixpacks"),
  domain: domainSchema.optional(),
  gitBranch: gitBranchSchema.default("main"),
  gitRepoUrl: gitRepoUrlSchema.optional(),
  name: serviceNameSchema,
  port: z.number().int().min(1).max(65_535).default(3000),
  sourceType: z.enum(["git", "docker_image", "compose"]),
});

/**
 * "Connect a repo" — the only deployment path the worker actually knows
 * how to run today: git repo, nixpacks build. `sourceType` is therefore
 * not a choice here, unlike in `serviceInputSchema`: offering
 * `docker_image` or `compose` in a form before the worker knows how to
 * build them would dangle a feature that would fail on the first
 * deployment.
 */
export const connectRepoSchema = z.object({
  domain: domainSchema.optional(),
  environmentName: environmentNameSchema,
  gitBranch: gitBranchSchema.default("main"),
  gitRepoUrl: gitRepoUrlSchema,
  name: serviceNameSchema,
  port: z.number().int().min(1).max(65_535).default(3000),
  projectName: projectNameSchema,
  serverId: z.uuid(),
});

export type ConnectRepoInput = z.infer<typeof connectRepoSchema>;

export type ServiceInput = z.infer<typeof serviceInputSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Compose stacks
// ─────────────────────────────────────────────────────────────────────────────

/** Same constraint as a compose service name on the worker side: what
 *  follows becomes `${stackName}_${key}` as a Swarm service name. */
export const composeServiceKeySchema = z
  .string()
  .min(1)
  .max(48)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, "invalid compose service key");

const composeFilePathSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(
    /^(?!\/)(?!.*\.\.)[\w./-]+$/,
    "expected a relative path, without escaping the repository"
  )
  .default("docker-compose.yml");

/**
 * "Connect a Compose repo" — like `connectRepoSchema`, but for multiple
 * containers under one name. AT MOST one service receives a Traefik route
 * (`publicService` + `domain` + `port`): that's the common case Compose
 * serves (app + sidecars), not N domains per stack.
 *
 * Split into two: `.refine()` strips `.extend()` from the type it
 * returns, and the form needs to redeclare `domain`/`port` (see their
 * comment in `connect-stack-dialog.tsx`) without redefining the other
 * eight fields.
 */
export const connectStackBaseSchema = z.object({
  composeFilePath: composeFilePathSchema,
  domain: domainSchema.optional(),
  environmentName: environmentNameSchema,
  gitBranch: gitBranchSchema.default("main"),
  gitRepoUrl: gitRepoUrlSchema,
  name: serviceNameSchema,
  port: z.number().int().min(1).max(65_535).optional(),
  projectName: projectNameSchema,
  publicService: composeServiceKeySchema.optional(),
  serverId: z.uuid(),
});

export const connectStackSchema = connectStackBaseSchema.refine(
  (v) => !v.publicService || v.port !== undefined,
  {
    message: "a port is required to expose a service",
    path: ["port"],
  }
);

export type ConnectStackInput = z.infer<typeof connectStackSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// environment variables
// ─────────────────────────────────────────────────────────────────────────────

export const envVarKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(
    /^[A-Za-z_][A-Za-z0-9_]*$/,
    "expected a shell identifier: letters, digits and _, cannot start with a digit"
  );

export const envVarInputSchema = z.object({
  isSecret: z.boolean().default(false),
  key: envVarKeySchema,
  // A value can legitimately be empty, and contain anything. It's
  // `execArgv` that makes it harmless, not this validation.
  value: z.string().max(65_536),
});

export type EnvVarInput = z.infer<typeof envVarInputSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// deployments
// ─────────────────────────────────────────────────────────────────────────────

export const deployRequestSchema = z.object({
  /** Absent = HEAD of the configured branch. */
  commitSha: z
    .string()
    .regex(/^[0-9a-f]{7,40}$/, "invalid commit SHA")
    .optional(),
  serviceId: z.uuid(),
});

export type DeployRequest = z.infer<typeof deployRequestSchema>;

/**
 * Stop, restart, relaunch.
 *
 * The three travel together because they share a consequence: none of
 * them destroys anything and all of them are recoverable by their
 * opposite. That's what groups them with `deploy` and not with `delete`
 * in the permissions model.
 */
export const lifecycleRequestSchema = z.object({
  action: z.enum(["start", "stop", "restart"]),
  serviceId: z.uuid(),
});

export type LifecycleRequest = z.infer<typeof lifecycleRequestSchema>;

/** Same shape, for a database — see `runDatabaseLifecycle` on the worker side. */
export const databaseLifecycleRequestSchema = z.object({
  action: z.enum(["start", "stop", "restart"]),
  databaseId: z.uuid(),
});

export type DatabaseLifecycleRequest = z.infer<
  typeof databaseLifecycleRequestSchema
>;

export const rollbackRequestSchema = z.object({
  /**
   * The deployment to roll back to. Explicit, not "the previous one":
   * Noddle keeps the whole history and can target any version, whereas
   * Swarm only keeps one prior spec.
   */
  deploymentId: z.uuid(),
  serviceId: z.uuid(),
});

export type RollbackRequest = z.infer<typeof rollbackRequestSchema>;

export const stackDeployRequestSchema = z.object({
  stackId: z.uuid(),
});

export type StackDeployRequest = z.infer<typeof stackDeployRequestSchema>;

export const stackRollbackRequestSchema = z.object({
  /** The `stack_deployments` row to roll back to — same principle as
   *  `rollbackRequestSchema`, one per stack rather than per service. */
  sourceDeploymentId: z.uuid(),
  stackId: z.uuid(),
});

export type StackRollbackRequest = z.infer<typeof stackRollbackRequestSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// one-click databases
// ─────────────────────────────────────────────────────────────────────────────

// Drawn from `DATABASE_ENGINES`, never copied: adding an engine there
// without adding it here would give a form that offers it and a server
// that refuses it.
export const databaseEngineSchema = z.enum(DATABASE_ENGINES);

/**
 * "Connect a database" — like `connectRepoSchema`/`connectStackSchema`:
 * find-or-create project and environment by name. No field for the
 * password: Noddle generates it, it's never entered nor displayed.
 */
/**
 * The name of a database AND that of a user, inside the engine.
 *
 * Deliberately narrower than what Postgres accepts: without quotes, an
 * unquoted SQL identifier is folded to lowercase and admits neither a
 * dash nor a space. Sticking to that avoids having to quote — and
 * therefore escape — in the healthcheck, the connection string and the
 * argv of `pg_dump`/`pg_restore`, three places where a botched quote
 * would only show up at runtime.
 */
const sqlIdentifierSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(
    /^[a-z_][a-z0-9_]*$/,
    "use lowercase letters, digits and underscores, starting with a letter"
  );

/**
 * A Docker image reference, for the "engine version" field.
 *
 * It is NOT validated against a list: the point of the field is precisely
 * to target a version Noddle doesn't know about. We only reject what
 * would break the command line — spaces and quotes.
 */
const imageRefSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[\w][\w.\-/:@]*$/, "not a valid image reference");

/**
 * The port published on the host, or `null` to stop exposing it.
 *
 * The whole range is allowed: Swarm publishes in `ingress` mode and its
 * daemon runs as root, so a port under 1024 works. Inventing a floor here
 * would forbid a legitimate case without protecting against anything —
 * it's the conflict with another service that settles it, and Docker
 * refuses it itself.
 */
export const databaseExternalPortSchema = z.object({
  databaseId: z.uuid(),
  externalPort: z.number().int().min(1).max(65_535).nullable(),
});

/** The minimum Docker accepts for a memory limit (6 MiB). Below that, the
 *  daemon refuses the spec — might as well say so at the boundary. */
const MIN_MEMORY_BYTES = 6 * 1024 * 1024;

/**
 * A database's resource limits.
 *
 * The wire carries Swarm's CANONICAL units (bytes, NanoCPUs), not
 * megabytes or cores: the conversion lives in ONE place, the UI, which
 * does it both ways. Two converters — one on input, one on render — would
 * eventually diverge, and whichever diverged on a memory limit would get
 * the container killed for the wrong value.
 *
 * Each field is nullable: `null` = no limit, the default state. The
 * reservation ≤ limit relationship is NOT checked here — a pure schema
 * only reliably knows one field at a time — but is checked server-side,
 * with a message.
 */
export const databaseResourcesSchema = z.object({
  cpuLimitNanos: z
    .number()
    .int()
    .min(100_000_000) // 0.1 core: below that, the limit has no practical meaning
    .max(64 * 1_000_000_000)
    .nullable(),
  cpuReservationNanos: z
    .number()
    .int()
    .min(100_000_000)
    .max(64 * 1_000_000_000)
    .nullable(),
  databaseId: z.uuid(),
  memoryLimitBytes: z
    .number()
    .int()
    .min(MIN_MEMORY_BYTES)
    .max(1024 * 1024 * 1024 * 1024) // 1 TiB, a guard-rail ceiling
    .nullable(),
  memoryReservationBytes: z
    .number()
    .int()
    .min(MIN_MEMORY_BYTES)
    .max(1024 * 1024 * 1024 * 1024)
    .nullable(),
});

/**
 * A database's new password.
 *
 * Same bounds as at creation time (`rootPassword`) and for the same
 * reason: no complexity rule is imposed, because the field exists
 * precisely to set a password imposed from the outside.
 */
export const changeDatabasePasswordSchema = z.object({
  databaseId: z.uuid(),
  password: z.string().min(1).max(200),
});

export const connectDatabaseSchema = z.object({
  /**
   * The four credential fields are OPTIONAL, and that's the design point:
   * an installation with no particular constraint fills in nothing and
   * gets exactly the previous behavior — user `noddle`, database of the
   * same name, generated password, pinned image. The field only exists
   * for the application whose configuration imposes its own name.
   */
  databaseName: sqlIdentifierSchema.optional(),
  description: z.string().max(280).optional(),
  engine: databaseEngineSchema,
  environmentName: environmentNameSchema,
  image: imageRefSchema.optional(),
  name: serviceNameSchema,
  projectName: projectNameSchema,
  /**
   * If provided, used as-is; if absent, Noddle generates one.
   *
   * No `min(8)` nor complexity rule: the generated default is already 48
   * hex characters long, and refusing the password the user MUST use —
   * because it's already written into an application they're migrating —
   * would amount to forbidding the very use of the field.
   */
  rootPassword: z.string().min(1).max(200).optional(),
  rootUser: sqlIdentifierSchema.optional(),
  serverId: z.uuid(),
});

export type ConnectDatabaseInput = z.infer<typeof connectDatabaseSchema>;

/**
 * Writes the connection string directly as an environment variable of the
 * chosen service — never returned to the client. `envVarKey` has a
 * suggested default on the UI side (`DATABASE_URL`/`REDIS_URL`) but stays
 * the user's choice, so as not to conflict with a variable already set.
 */
export const attachDatabaseSchema = z.object({
  databaseId: z.uuid(),
  envVarKey: envVarKeySchema,
  serviceId: z.uuid(),
});

export type AttachDatabaseInput = z.infer<typeof attachDatabaseSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// S3 backups
// ─────────────────────────────────────────────────────────────────────────────

/**
 * AWS's rules, not ours: 3 to 63 characters, lowercase, digits, dots and
 * dashes, starting and ending with an alphanumeric character. A bucket in
 * uppercase is refused by the service itself, so might as well say so in
 * the form rather than at the first backup.
 */
export const bucketNameSchema = z
  .string()
  .min(3, "Bucket names are at least 3 characters.")
  .max(63, "Keep the bucket name under 63 characters.")
  .regex(
    /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/,
    "Lowercase letters, digits, dots and dashes; start and end alphanumeric."
  );

/**
 * Key prefix. Optional, and normalized without a leading or trailing `/`:
 * it's glued back together with an explicit separator when building the
 * key, and two sources of truth about who adds the slash would produce
 * `noddle//database/…` keys.
 */
export const objectPrefixSchema = z
  .string()
  .max(256, "Keep the prefix under 256 characters.")
  .regex(/^[a-zA-Z0-9!\-_.*'()/]*$/, "only characters safe for an S3 key")
  .refine((v) => !v.includes(".."), "`..` is not allowed in a prefix")
  .transform((v) =>
    v.replace(LEADING_SLASHES, "").replace(TRAILING_SLASHES, "")
  );

/**
 * Wire format for an S3 destination (create or update).
 *
 * Messages are WRITTEN, not left to Zod's default: they surface under the
 * field in the form and in the server-function error — one place to fix.
 *
 * EMPTY `secretAccessKey` is allowed on purpose: on an already-registered
 * destination, a field left empty means "keep the stored key". Creation
 * uses {@link s3DestinationCreateSchema}, which requires a secret.
 */
export const s3DestinationSchema = z.object({
  accessKeyId: z
    .string()
    .min(1, "Enter the access key ID.")
    .max(128, "Keep the access key ID under 128 characters."),
  bucket: bucketNameSchema,
  endpoint: z
    .string()
    .min(1, "Enter the S3 service URL.")
    .max(512, "Keep the endpoint under 512 characters.")
    .refine(
      (v) => HTTP_OR_HTTPS_URL.test(v),
      "Enter an http:// or https:// URL."
    ),
  // True everywhere except on Amazon's own S3: `bucket.host` doesn't
  // resolve for RustFS, MinIO or an instance reached by IP.
  forcePathStyle: z.boolean().default(true),

  /** Absent = creation. Present = updating THIS destination. */
  id: z.uuid().optional(),

  // What distinguishes two buckets in a selector. A URL isn't enough: two
  // buckets on the same service share the same host.
  name: z
    .string()
    .min(1, "Give this destination a name.")
    .max(64, "Keep the name under 64 characters."),
  prefix: objectPrefixSchema.default(""),
  // Enters into the SigV4 signature computation: a wrong region makes
  // authentication fail, even on an implementation that otherwise ignores
  // it.
  region: z
    .string()
    .min(1, "Enter a region.")
    .max(64, "Keep the region under 64 characters.")
    .default("us-east-1"),
  secretAccessKey: z
    .string()
    .max(256, "Keep the secret access key under 256 characters."),
});

/** Creation: same fields, but a secret is required (nothing to keep yet). */
export const s3DestinationCreateSchema = s3DestinationSchema.refine(
  (v) => v.secretAccessKey.length > 0,
  {
    message: "A secret access key is required.",
    path: ["secretAccessKey"],
  }
);

export const destinationIdSchema = z.object({ id: z.uuid() });

// The messages are WRITTEN, not left to Zod's default: "Too small:
// expected string to have >=1 characters" is developer text, and it
// surfaces as-is on both sides — under the field in the form, and in the
// error the server function returns. A single place to fix.
export const registrySchema = z.object({
  /** Absent = creation. Present = updating THIS registry. */
  id: z.uuid().optional(),
  imagePrefix: z
    .string()
    .max(128, "Keep the prefix under 128 characters.")
    .default(""),
  name: z
    .string()
    .min(1, "Give this registry a name.")
    .max(64, "Keep the name under 64 characters."),
  // Empty allowed, same reason as the S3 secret key: the password never
  // comes back from the server, so on an update an empty field means
  // "keep the one that's stored". It's the handler that requires it when
  // there's nothing to keep.
  password: z.string().max(256),
  // A HOST, not a URL: Docker expects `ghcr.io` or `host:5000`, never
  // `https://…`. A prefix stuck to an image would make it impossible to
  // pull.
  registryUrl: z
    .string()
    .min(1, "Enter the registry host, such as ghcr.io.")
    .max(255, "Keep the host under 255 characters.")
    // `v === ""` passes: the `min(1)` right above ALREADY rejected it,
    // and without this bailout an empty field carried TWO stacked
    // messages — "enter the host" then "without http://", the second of
    // which makes no sense on an empty value. Zod returns every issue
    // for a given field, it doesn't stop at the first one.
    .refine(
      (v) => v === "" || REGISTRY_HOST.test(v),
      "Enter a hostname such as ghcr.io, without http:// or a path"
    ),
  username: z
    .string()
    .min(1, "The registry needs a username.")
    .max(128, "Keep the username under 128 characters."),
});

export const registryIdSchema = z.object({ id: z.uuid() });

// `null` = the embedded registry. This is an explicit CHOICE, not an
// absence of value: the selector offers it as the first option.
export const serviceRegistrySchema = z.object({
  registryId: z.uuid().nullable(),
  serviceId: z.uuid(),
});

export type RegistryInput = z.infer<typeof registrySchema>;

export const createProjectSchema = z.object({
  description: z.string().max(280).optional(),
  /** The first environment, created WITH the project. A project with no
   *  environment is unreachable from any screen — `/projects/<id>`
   *  redirects to the first one and wouldn't find any. */
  environmentName: environmentNameSchema.default("production"),
  name: projectNameSchema,
});

export const renameProjectSchema = z.object({
  description: z.string().max(280).optional(),
  name: projectNameSchema,
  projectId: z.uuid(),
});

export const projectIdSchema = z.object({ projectId: z.uuid() });

export const createEnvironmentSchema = z.object({
  description: z.string().max(280).optional(),
  name: environmentNameSchema,
  projectId: z.uuid(),
});

export const renameEnvironmentSchema = z.object({
  description: z.string().max(280).optional(),
  environmentId: z.uuid(),
  name: environmentNameSchema,
});

export const environmentIdSchema = z.object({ environmentId: z.uuid() });

export const duplicateEnvironmentSchema = z.object({
  environmentId: z.uuid(),
  name: environmentNameSchema,
});

export const moveServiceSchema = z.object({
  environmentId: z.uuid(),
  serviceId: z.uuid(),
});

export type BackupDestinationInput = z.infer<typeof s3DestinationSchema>;

export const backupRequestSchema = z.object({
  databaseId: z.uuid(),
});

export type BackupRequest = z.infer<typeof backupRequestSchema>;

/**
 * Restoring is the product's ONLY irreversible operation: it overwrites
 * current data, whereas replaying an image destroys nothing.
 *
 * `confirmName` carries that difference all the way to the server. A
 * dialog asking you to type the name only protects clients that display
 * it; requiring the name HERE means the safeguard exists for real,
 * whoever the caller is. `databaseId` is requested for the same reason:
 * it's derivable from the backup, but supplying it lets us reject a
 * cross-database restore rather than discover it afterward.
 */
// ─────────────────────────────────────────────────────────────────────────────
// notifications
// ─────────────────────────────────────────────────────────────────────────────

export const notificationKindSchema = z.enum(["webhook", "discord", "slack"]);

/**
 * A channel's URL.
 *
 * `http` is accepted, `https` required for Discord and Slack. These URLs
 * are bearer secrets — whoever holds them can post to the channel — so
 * letting them travel in plaintext isn't harmless. But a homegrown webhook
 * on an internal service (`http://10.0.0.5:5678`) is a legitimate and
 * frequent case in self-hosting; forbidding it wouldn't secure anyone, it
 * would push people to bypass Noddle.
 */
export const notificationUrlSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (v) => HTTP_OR_HTTPS_URL.test(v),
    "expected an http:// or https:// URL"
  );

/**
 * Discord and Slack ONLY serve https: an `http` URL for them isn't an
 * infrastructure choice, it's a typo that would fail on the first
 * delivery attempt. We reject it in the form rather than at the moment an
 * alert was supposed to go out.
 */
function hostedChannelIsHttps(data: {
  kind: "discord" | "slack" | "webhook";
  url?: string;
}): boolean {
  if (data.kind === "webhook" || !data.url) {
    return true;
  }
  return HTTPS_URL.test(data.url);
}

const HOSTED_HTTPS_MESSAGE = "Discord and Slack only accept https:// URLs";

export const notificationChannelSchema = z
  .object({
    kind: notificationKindSchema,
    name: z.string().min(1).max(64),
    notifySuccess: z.boolean().default(false),
    url: notificationUrlSchema,
  })
  .refine(hostedChannelIsHttps, HOSTED_HTTPS_MESSAGE);

export type NotificationChannelInput = z.infer<
  typeof notificationChannelSchema
>;

/**
 * Editing an existing channel. The URL is optional: it never comes back
 * from the server — same rule as the S3 secret key and a database
 * password — so leaving it empty means "keep the previous one".
 */
export const notificationChannelUpdateSchema = z
  .object({
    channelId: z.uuid(),
    enabled: z.boolean(),
    kind: notificationKindSchema,
    name: z.string().min(1).max(64),
    notifySuccess: z.boolean(),
    url: notificationUrlSchema.optional(),
  })
  .refine(hostedChannelIsHttps, HOSTED_HTTPS_MESSAGE);

export type NotificationChannelUpdate = z.infer<
  typeof notificationChannelUpdateSchema
>;

export const notificationChannelIdSchema = z.object({ channelId: z.uuid() });

export const backupScheduleSchema = z.enum(["off", "daily", "weekly"]);

/**
 * A database's automatic backup setting.
 *
 * Retention is bounded both above AND below: at 0 you'd erase the backup
 * just taken, and beyond a hundred you're no longer keeping a history but
 * a storage bill nobody rereads.
 */
export const backupScheduleRequestSchema = z.object({
  databaseId: z.uuid(),
  retention: z.number().int().min(1).max(100),
  // `null` = "the one there is". Explicitly nullable rather than absent:
  // setting a database back to "automatic" is a choice you must be able
  // to express, not just a field you omit.
  s3DestinationId: z.uuid().nullable().default(null),
  schedule: backupScheduleSchema,
});

export type BackupScheduleRequest = z.infer<typeof backupScheduleRequestSchema>;

export const restoreRequestSchema = z.object({
  backupId: z.uuid(),
  confirmName: z.string().min(1).max(48),
  databaseId: z.uuid(),
});

export type RestoreRequest = z.infer<typeof restoreRequestSchema>;

/**
 * Deleting a service is irreversible: the history, images and variables
 * go with it. Same requirement as a restore, hence — `confirmName` carries
 * the typed name to the SERVER, which re-checks it. A dialog only
 * protects clients that display it.
 */
export const deleteServiceSchema = z.object({
  confirmName: z.string().min(1).max(48),
  serviceId: z.uuid(),
});

export type DeleteServiceRequest = z.infer<typeof deleteServiceSchema>;

/**
 * Deleting a stack, a database, a server.
 *
 * All three require RETYPING THE NAME, like a service and like a restore.
 * This isn't UI politeness: the name is re-checked server-side, because a
 * dialog only protects clients that display it.
 *
 * `max(64)` and not 48: a server name follows `serverInputSchema`, wider
 * than `serviceNameSchema`.
 */
export const deleteStackSchema = z.object({
  confirmName: z.string().min(1).max(48),
  stackId: z.uuid(),
});

export type DeleteStackRequest = z.infer<typeof deleteStackSchema>;

export const deleteDatabaseSchema = z.object({
  confirmName: z.string().min(1).max(48),
  databaseId: z.uuid(),
});

export type DeleteDatabaseRequest = z.infer<typeof deleteDatabaseSchema>;

/** Same shape as `deleteDatabaseSchema`: "rebuild" empties the database
 *  the way "delete" empties the installation, and both are protected the
 *  same way — by retyping the name, re-checked server-side. */
export const rebuildDatabaseSchema = z.object({
  confirmName: z.string().min(1).max(48),
  databaseId: z.uuid(),
});

export const deleteServerSchema = z.object({
  confirmName: z.string().min(1).max(64),
  serverId: z.uuid(),
});

export type DeleteServerRequest = z.infer<typeof deleteServerSchema>;

export const serviceMetricsRequestSchema = z.object({ serviceId: z.uuid() });

export const databaseMetricsRequestSchema = z.object({ databaseId: z.uuid() });

// ─────────────────────────────────────────────────────────────────────────────
// accounts
// ─────────────────────────────────────────────────────────────────────────────

export const accountRoleNameSchema = z.enum([
  "owner",
  "admin",
  "deployer",
  "viewer",
]);

export const createAccountSchema = z.object({
  email: z.email(),
  name: z.string().min(1).max(64),
  role: accountRoleNameSchema,
});

export const accountRoleSchema = z.object({
  role: accountRoleNameSchema,
  userId: z.string().min(1),
});

/**
 * Deleting an account requires RETYPING ITS ADDRESS, like a service
 * requires its name. It's the product's most discreet action — a button
 * in a table row — and the only one nothing can be reconstructed from: the
 * audit log survives (`ON DELETE SET NULL` + denormalized `actor_email`),
 * but the account, its sessions and its password don't.
 *
 * It's the ADDRESS and not the name: two people can share a name, and
 * it's the address the row displays.
 *
 * `z.string()` and not `z.email()`: this field doesn't carry an address to
 * validate but an input to COMPARE. Validating it as an address would fail
 * a mistyped confirmation on a format error, where the only useful
 * response is "that doesn't match". The max follows the RFC 5321 limit.
 */
export const deleteAccountSchema = z.object({
  confirmEmail: z.string().min(1).max(254),
  userId: z.string().min(1),
});

export type DeleteAccountRequest = z.infer<typeof deleteAccountSchema>;
