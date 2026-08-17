import { DATABASE_ENGINES } from "@noddle/database-spec";
import { z } from "zod";

import { envVarKeySchema } from "./env-var.ts";
import { environmentNameSchema, projectNameSchema } from "./project.ts";
import { serviceNameSchema } from "./service.ts";

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
export const imageRefSchema = z
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
 * Post-creation engine image for a database.
 *
 * Same bounds as `connectDatabaseSchema.image`. Changing the tag under an
 * existing volume is the operator's call — a major bump can crash-loop or
 * empty the data dir; the screen warns, the worker does not second-guess.
 */
export const databaseConfigurationSchema = z.object({
  databaseId: z.uuid(),
  image: imageRefSchema,
});

export const databaseReplicasSchema = z.object({
  databaseId: z.uuid(),
  replicas: z.number().int().min(1).max(50),
});

const absPathSchema = z
  .string()
  .min(1)
  .max(500)
  .regex(/^\/[\w.\-/]*$/, "must be an absolute path");

export const databaseVolumePathSchema = z.object({
  databaseId: z.uuid(),
  volumePath: absPathSchema.nullable(),
});

export const databaseMountTypeSchema = z.enum(["bind", "volume"]);

export const databaseExtraMountSchema = z.object({
  id: z.uuid(),
  source: z
    .string()
    .min(1)
    .max(500)
    .regex(/^[\w.\-/:@]+$/, "not a valid mount source"),
  target: absPathSchema,
  type: databaseMountTypeSchema,
});

export const addDatabaseMountSchema = z.object({
  databaseId: z.uuid(),
  source: databaseExtraMountSchema.shape.source,
  target: databaseExtraMountSchema.shape.target,
  type: databaseMountTypeSchema,
});

export const updateDatabaseMountSchema = z.object({
  databaseId: z.uuid(),
  mountId: z.uuid(),
  source: databaseExtraMountSchema.shape.source,
  target: databaseExtraMountSchema.shape.target,
  type: databaseMountTypeSchema,
});

export const deleteDatabaseMountSchema = z.object({
  databaseId: z.uuid(),
  mountId: z.uuid(),
});

const healthCheckSwarmSchema = z
  .object({
    Interval: z.number().int().nullable().optional(),
    Retries: z.number().int().nullable().optional(),
    StartPeriod: z.number().int().nullable().optional(),
    Test: z.array(z.string()).nullable().optional(),
    Timeout: z.number().int().nullable().optional(),
  })
  .nullable();

const restartPolicySwarmSchema = z
  .object({
    Condition: z.enum(["any", "none", "on-failure"]).optional(),
    Delay: z.number().int().nullable().optional(),
    MaxAttempts: z.number().int().nullable().optional(),
    Window: z.number().int().nullable().optional(),
  })
  .nullable();

const placementSwarmSchema = z
  .object({
    Constraints: z.array(z.string()).optional(),
    MaxReplicas: z.number().int().optional(),
    Preferences: z
      .array(z.object({ Spread: z.object({ SpreadDescriptor: z.string() }) }))
      .optional(),
  })
  .nullable();

const updateConfigSwarmSchema = z
  .object({
    Delay: z.number().int().nullable().optional(),
    FailureAction: z.enum(["continue", "pause", "rollback"]).optional(),
    MaxFailureRatio: z.number().nullable().optional(),
    Monitor: z.number().int().nullable().optional(),
    Order: z.enum(["start-first", "stop-first"]).optional(),
    Parallelism: z.number().int().nullable().optional(),
  })
  .nullable();

const rollbackConfigSwarmSchema = z
  .object({
    Delay: z.number().int().nullable().optional(),
    FailureAction: z.enum(["continue", "pause"]).optional(),
    MaxFailureRatio: z.number().nullable().optional(),
    Monitor: z.number().int().nullable().optional(),
    Order: z.enum(["start-first", "stop-first"]).optional(),
    Parallelism: z.number().int().nullable().optional(),
  })
  .nullable();

const modeSwarmSchema = z
  .object({
    Global: z.object({}).optional(),
    Replicated: z.object({ Replicas: z.number().int().optional() }).optional(),
  })
  .nullable();

const labelsSwarmSchema = z.record(z.string(), z.string()).nullable();

const networkSwarmSchema = z
  .array(
    z.object({
      Aliases: z.array(z.string()).optional(),
      Target: z.string().min(1),
    })
  )
  .nullable();

const endpointSpecSwarmSchema = z
  .object({
    Mode: z.enum(["dnsrr", "vip"]).optional(),
  })
  .nullable();

export const databaseSwarmSettingsSchema = z.object({
  endpointSpec: endpointSpecSwarmSchema.optional(),
  healthCheck: healthCheckSwarmSchema.optional(),
  labels: labelsSwarmSchema.optional(),
  mode: modeSwarmSchema.optional(),
  networks: networkSwarmSchema.optional(),
  placement: placementSwarmSchema.optional(),
  restartPolicy: restartPolicySwarmSchema.optional(),
  rollbackConfig: rollbackConfigSwarmSchema.optional(),
  stopGracePeriod: z.number().int().nullable().optional(),
  updateConfig: updateConfigSwarmSchema.optional(),
});

export type DatabaseSwarmSettingsInput = z.infer<
  typeof databaseSwarmSettingsSchema
>;

export const setDatabaseSwarmSettingsSchema = z.object({
  databaseId: z.uuid(),
  /** Partial merge into the stored object; explicit `null` clears a key. */
  swarmSettings: databaseSwarmSettingsSchema,
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

/** Same shape, for a database — see `runDatabaseLifecycle` on the worker side. */
export const databaseLifecycleRequestSchema = z.object({
  action: z.enum(["start", "stop", "restart"]),
  databaseId: z.uuid(),
});

export type DatabaseLifecycleRequest = z.infer<
  typeof databaseLifecycleRequestSchema
>;

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
