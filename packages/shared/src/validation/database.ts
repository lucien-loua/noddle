import { z } from "zod";

import { DATABASE_ENGINES } from "#database-spec";

import { envVarKeySchema } from "./env-var.ts";
import { environmentNameSchema, projectNameSchema } from "./project.ts";
import { serviceNameSchema } from "./service.ts";

export const databaseEngineSchema = z.enum(
  DATABASE_ENGINES,
  "Choose a database engine."
);

const sqlIdentifierSchema = z
  .string()
  .min(1, "Enter a name.")
  .max(63, "Keep the name under 63 characters.")
  .regex(
    /^[a-z_][a-z0-9_]*$/,
    "use lowercase letters, digits and underscores, starting with a letter"
  );

export const imageRefSchema = z
  .string()
  .min(1, "Enter an image reference.")
  .max(200, "Keep the image reference under 200 characters.")
  .regex(/^[\w][\w.\-/:@]*$/, "not a valid image reference");

export const databaseExternalPortSchema = z.object({
  databaseId: z.uuid("Choose a database."),
  externalPort: z
    .number({ error: "Enter a port number." })
    .int("Enter a whole port number.")
    .min(1, "Ports start at 1.")
    .max(65_535, "Ports stop at 65535.")
    .nullable(),
});

const MIN_MEMORY_BYTES = 6 * 1024 * 1024;

export const databaseResourcesSchema = z.object({
  cpuLimitNanos: z
    .number({ error: "Enter a CPU limit." })
    .int("Enter a whole number.")
    .min(100_000_000, "Allow at least 0.1 CPU.")
    .max(64 * 1_000_000_000, "Allow at most 64 CPUs.")
    .nullable(),
  cpuReservationNanos: z
    .number({ error: "Enter a CPU reservation." })
    .int("Enter a whole number.")
    .min(100_000_000, "Reserve at least 0.1 CPU.")
    .max(64 * 1_000_000_000, "Reserve at most 64 CPUs.")
    .nullable(),
  databaseId: z.uuid("Choose a database."),
  memoryLimitBytes: z
    .number({ error: "Enter a memory limit." })
    .int("Enter a whole number of bytes.")
    .min(MIN_MEMORY_BYTES, "Allow at least 6 MB.")
    .max(1024 * 1024 * 1024 * 1024, "Allow at most 1 TB.")
    .nullable(),
  memoryReservationBytes: z
    .number({ error: "Enter a memory reservation." })
    .int("Enter a whole number of bytes.")
    .min(MIN_MEMORY_BYTES, "Reserve at least 6 MB.")
    .max(1024 * 1024 * 1024 * 1024, "Reserve at most 1 TB.")
    .nullable(),
});

export const databaseConfigurationSchema = z.object({
  databaseId: z.uuid("Choose a database."),
  image: imageRefSchema,
});

export const databaseReplicasSchema = z.object({
  databaseId: z.uuid("Choose a database."),
  replicas: z
    .number({ error: "Enter a replica count." })
    .int("Enter a whole number.")
    .min(1, "Run at least 1 replica.")
    .max(50, "Run at most 50 replicas."),
});

const absPathSchema = z
  .string()
  .min(1, "Enter a path.")
  .max(500, "Keep the path under 500 characters.")
  .regex(/^\/[\w.\-/]*$/, "must be an absolute path");

export const databaseVolumePathSchema = z.object({
  databaseId: z.uuid("Choose a database."),
  volumePath: absPathSchema.nullable(),
});

export const databaseMountTypeSchema = z.enum(
  ["bind", "volume"],
  "Choose a mount type."
);

export const databaseExtraMountSchema = z.object({
  id: z.uuid("Choose a mount."),
  source: z
    .string()
    .min(1, "Enter the volume name or host path.")
    .max(500, "Keep the source under 500 characters.")
    .regex(/^[\w.\-/:@]+$/, "not a valid mount source"),
  target: absPathSchema,
  type: databaseMountTypeSchema,
});

export const addDatabaseMountSchema = z.object({
  databaseId: z.uuid("Choose a database."),
  source: databaseExtraMountSchema.shape.source,
  target: databaseExtraMountSchema.shape.target,
  type: databaseMountTypeSchema,
});

export const updateDatabaseMountSchema = z.object({
  databaseId: z.uuid("Choose a database."),
  mountId: z.uuid("Choose a mount."),
  source: databaseExtraMountSchema.shape.source,
  target: databaseExtraMountSchema.shape.target,
  type: databaseMountTypeSchema,
});

export const deleteDatabaseMountSchema = z.object({
  databaseId: z.uuid("Choose a database."),
  mountId: z.uuid("Choose a mount."),
});

const swarmNumberSchema = z
  .number({ error: "Enter a number." })
  .int("Enter a whole number.");

const healthCheckSwarmSchema = z
  .object({
    Interval: swarmNumberSchema.nullable().optional(),
    Retries: swarmNumberSchema.nullable().optional(),
    StartPeriod: swarmNumberSchema.nullable().optional(),
    Test: z.array(z.string(), "Enter a list of values.").nullable().optional(),
    Timeout: swarmNumberSchema.nullable().optional(),
  })
  .nullable();

const restartPolicySwarmSchema = z
  .object({
    Condition: z
      .enum(["any", "none", "on-failure"], "Choose any, none or on-failure.")
      .optional(),
    Delay: swarmNumberSchema.nullable().optional(),
    MaxAttempts: swarmNumberSchema.nullable().optional(),
    Window: swarmNumberSchema.nullable().optional(),
  })
  .nullable();

const placementSwarmSchema = z
  .object({
    Constraints: z.array(z.string(), "Enter a list of values.").optional(),
    MaxReplicas: swarmNumberSchema.optional(),
    Preferences: z
      .array(
        z.object({
          Spread: z.object({
            SpreadDescriptor: z.string({ error: "Enter a spread descriptor." }),
          }),
        })
      )
      .optional(),
  })
  .nullable();

const updateConfigSwarmSchema = z
  .object({
    Delay: swarmNumberSchema.nullable().optional(),
    FailureAction: z
      .enum(
        ["continue", "pause", "rollback"],
        "Choose continue, pause or rollback."
      )
      .optional(),
    MaxFailureRatio: z
      .number({ error: "Enter a number." })
      .nullable()
      .optional(),
    Monitor: swarmNumberSchema.nullable().optional(),
    Order: z
      .enum(["start-first", "stop-first"], "Choose start-first or stop-first.")
      .optional(),
    Parallelism: swarmNumberSchema.nullable().optional(),
  })
  .nullable();

const rollbackConfigSwarmSchema = z
  .object({
    Delay: swarmNumberSchema.nullable().optional(),
    FailureAction: z
      .enum(["continue", "pause"], "Choose continue or pause.")
      .optional(),
    MaxFailureRatio: z
      .number({ error: "Enter a number." })
      .nullable()
      .optional(),
    Monitor: swarmNumberSchema.nullable().optional(),
    Order: z
      .enum(["start-first", "stop-first"], "Choose start-first or stop-first.")
      .optional(),
    Parallelism: swarmNumberSchema.nullable().optional(),
  })
  .nullable();

const modeSwarmSchema = z
  .object({
    Global: z.object({}).optional(),
    Replicated: z
      .object({
        Replicas: swarmNumberSchema.optional(),
      })
      .optional(),
  })
  .nullable();

const labelsSwarmSchema = z
  .record(z.string(), z.string(), "Enter labels as name and value pairs.")
  .nullable();

const networkSwarmSchema = z
  .array(
    z.object({
      Aliases: z.array(z.string(), "Enter a list of values.").optional(),
      Target: z.string().min(1, "Enter the network name."),
    })
  )
  .nullable();

const endpointSpecSwarmSchema = z
  .object({
    Mode: z.enum(["dnsrr", "vip"], "Choose dnsrr or vip.").optional(),
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
  stopGracePeriod: swarmNumberSchema.nullable().optional(),
  updateConfig: updateConfigSwarmSchema.optional(),
});

export type DatabaseSwarmSettingsInput = z.infer<
  typeof databaseSwarmSettingsSchema
>;

export const setDatabaseSwarmSettingsSchema = z.object({
  databaseId: z.uuid("Choose a database."),
  swarmSettings: databaseSwarmSettingsSchema,
});

export const changeDatabasePasswordSchema = z.object({
  databaseId: z.uuid("Choose a database."),
  password: z
    .string()
    .min(1, "Enter a password.")
    .max(200, "Keep the password under 200 characters."),
});

export const connectDatabaseSchema = z.object({
  databaseName: sqlIdentifierSchema.optional(),
  description: z
    .string()
    .max(280, "Keep the description under 280 characters.")
    .optional(),
  engine: databaseEngineSchema,
  environmentName: environmentNameSchema,
  image: imageRefSchema.optional(),
  name: serviceNameSchema,
  projectName: projectNameSchema,
  rootPassword: z
    .string()
    .min(1, "Enter a password.")
    .max(200, "Keep the password under 200 characters.")
    .optional(),
  rootUser: sqlIdentifierSchema.optional(),
  serverId: z.uuid("Choose a server."),
});

export type ConnectDatabaseInput = z.infer<typeof connectDatabaseSchema>;

export const attachDatabaseSchema = z.object({
  databaseId: z.uuid("Choose a database."),
  envVarKey: envVarKeySchema,
  serviceId: z.uuid("Choose a service."),
});

export type AttachDatabaseInput = z.infer<typeof attachDatabaseSchema>;

export const databaseLifecycleRequestSchema = z.object({
  action: z.enum(["start", "stop", "restart"], "Choose an action."),
  databaseId: z.uuid("Choose a database."),
});

export type DatabaseLifecycleRequest = z.infer<
  typeof databaseLifecycleRequestSchema
>;

export const deleteDatabaseSchema = z.object({
  confirmName: z
    .string()
    .min(1, "Type the database name to confirm.")
    .max(48, "Keep the name under 48 characters."),
  databaseId: z.uuid("Choose a database."),
});

export type DeleteDatabaseRequest = z.infer<typeof deleteDatabaseSchema>;

export const rebuildDatabaseSchema = z.object({
  confirmName: z
    .string()
    .min(1, "Type the database name to confirm.")
    .max(48, "Keep the name under 48 characters."),
  databaseId: z.uuid("Choose a database."),
});
