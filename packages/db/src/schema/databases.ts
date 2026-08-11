import {
  bigint,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, updatedAt } from "#schema/columns";
import { environments } from "#schema/projects";
import { servers } from "#schema/servers";
import { serviceStatus } from "#schema/services";

/** Extra bind/volume mounts on a database service (not the primary data volume). */
export interface DatabaseExtraMount {
  id: string;
  /** Host path (bind) or volume name (volume). */
  source: string;
  /** Absolute path inside the container. */
  target: string;
  type: "bind" | "volume";
}

/**
 * Optional Swarm service overrides stored as one JSON object.
 * `null` / missing keys = Noddle's built-in defaults (engine healthcheck,
 * node placement, overlay network).
 */
export interface DatabaseSwarmSettings {
  endpointSpec?: {
    Mode?: "dnsrr" | "vip";
  } | null;
  healthCheck?: {
    Interval?: number | null;
    Retries?: number | null;
    StartPeriod?: number | null;
    Test?: string[] | null;
    Timeout?: number | null;
  } | null;
  labels?: Record<string, string> | null;
  mode?: {
    Global?: Record<string, never>;
    Replicated?: { Replicas?: number };
  } | null;
  networks?: Array<{ Aliases?: string[]; Target: string }> | null;
  placement?: {
    Constraints?: string[];
    MaxReplicas?: number;
    Preferences?: Array<{ Spread: { SpreadDescriptor: string } }>;
  } | null;
  restartPolicy?: {
    Condition?: "any" | "none" | "on-failure";
    Delay?: number | null;
    MaxAttempts?: number | null;
    Window?: number | null;
  } | null;
  rollbackConfig?: {
    Delay?: number | null;
    FailureAction?: "continue" | "pause";
    MaxFailureRatio?: number | null;
    Monitor?: number | null;
    Order?: "start-first" | "stop-first";
    Parallelism?: number | null;
  } | null;
  stopGracePeriod?: number | null;
  updateConfig?: {
    Delay?: number | null;
    FailureAction?: "continue" | "pause" | "rollback";
    MaxFailureRatio?: number | null;
    Monitor?: number | null;
    Order?: "start-first" | "stop-first";
    Parallelism?: number | null;
  } | null;
}

export const databaseEngine = pgEnum("database_engine", [
  "postgres",
  "mysql",
  "mariadb",
  "mongo",
  "redis",
]);

export const databases = pgTable(
  "databases",
  {
    /**
     * CPU cap in NanoCPUs (1 core = 1e9), `null` = no limit.
     *
     * An intentional bend of "Docker knobs are not exposed as form fields",
     * same family as `image` just above: the target VM is 2 GB BY DECISION, and
     * the Monitoring tab already announces "no limit declared" without giving
     * a way to act. A need already seen on this kind of Advanced tab.
     *
     * The stored unit is Swarm's (`Limits.NanoCPUs`), read as-is by the worker;
     * the screen converts to/from cores. Same principle as `service_metrics`,
     * which stores raw bytes and lets the UI divide.
     */
    cpuLimitNanos: bigint("cpu_limit_nanos", { mode: "number" }),

    /** CPU reservation in NanoCPUs (`Reservations.NanoCPUs`): what the node
     *  guarantees before placing. Must stay ≤ the limit — checked on save,
     *  like `memoryReservationBytes`. `null` = no reservation. */
    cpuReservationNanos: bigint("cpu_reservation_nanos", { mode: "number" }),
    createdAt,

    /**
     * The database name INSIDE the server, distinct from `name` (which names
     * the resource in Noddle) and from `rootUser`.
     *
     * It used to equal `rootUser` — `POSTGRES_DB=${rootUser}` — so all three
     * were the same word. Separated because an app whose config expects
     * `POSTGRES_DB=shop` cannot live with `noddle`, and because restoring a
     * dump from elsewhere assumes you can target the name it contains.
     *
     * `null` for engines that have no such notion — Redis only has database
     * numbers.
     */
    databaseName: text("database_name"),

    /** Free-form user text. Has no effect on the deploy. */
    description: text("description"),
    engine: databaseEngine("engine").notNull(),
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),

    /**
     * The port PUBLISHED on the host, `null` = the database is only reachable
     * from the overlay network.
     *
     * This is the only way to reach a database from outside: a database does
     * not go through Traefik, which routes HTTP while an engine speaks its own
     * protocol over TCP. Publishing a port is therefore an explicit choice,
     * and it exposes the engine to anything that can reach the machine —
     * hence the screen copy, which says so rather than implying it.
     */
    externalPort: integer("external_port"),

    /**
     * User-added mounts (bind / named volume). The primary data volume is
     * ALWAYS `swarmName` → `volumePath` and is never stored here.
     */
    extraMounts: jsonb("extra_mounts")
      .$type<DatabaseExtraMount[]>()
      .notNull()
      .default([]),
    id: uuid("id").primaryKey().defaultRandom(),

    /**
     * Container image, `null` = the engine's pinned default.
     *
     * An INTENTIONAL bend of "Docker knobs are not exposed as form fields":
     * this is not a Docker knob, it is the engine VERSION, and it is imposed
     * from outside — a PostgreSQL 15 dump does not restore into a 17, and
     * `pg_dump` flatly refuses a server newer than itself (already noted in
     * `backup.ts`).
     *
     * Editable after creation (Advanced → Configuration). A major bump under
     * an existing volume can crash-loop or ignore the data directory — the
     * screen warns; the worker applies whatever is stored here on the next
     * provision.
     */
    image: text("image"),

    // Why a teardown failed — same reason as `services.lastError`.
    lastError: text("last_error"),

    /** Memory cap in BYTES (`Limits.MemoryBytes`), `null` = no limit. See
     *  `cpuLimitNanos`. */
    memoryLimitBytes: bigint("memory_limit_bytes", { mode: "number" }),

    /** Memory reservation in bytes (`Reservations.MemoryBytes`): what the
     *  node guarantees before placing. Must stay ≤ the limit — checked on
     *  save. `null` = no reservation. */
    memoryReservationBytes: bigint("memory_reservation_bytes", {
      mode: "number",
    }),

    name: text("name").notNull(),

    /**
     * Desired Swarm replicas. Default 1. Values > 1 with a local named
     * volume are unsafe (corruption / empty second task) — the screen warns;
     * the worker still applies what is stored.
     */
    replicas: integer("replicas").notNull().default(1),

    // Never returned to the browser, even encrypted, even once. Attaching a
    // database to a service writes an ENCRYPTED environment variable directly
    // server-side — the password never crosses the network to the client,
    // unlike a webhook secret that must be handed to a third party.
    rootPasswordEncrypted: text("root_password_encrypted").notNull(),

    // Absent for redis, which has no user notion — only a password.
    rootUser: text("root_user"),

    // Like `services.serverId`: the named volume exists only on THIS node,
    // the link is structural, not mere placement.
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "restrict" }),
    status: serviceStatus("status").notNull().default("created"),

    // Swarm service name AND its volume, WRITTEN at creation and never
    // recomputed.
    //
    // Recomputing it would break THREE things at once, all silently: the named
    // volume (the database restarts empty, with no error), the host written
    // into every connection string already encrypted in an attached service's
    // variables, and the target `backup.ts` finds to dump. Rows from before
    // this fix are therefore backfilled to `noddle-db-<name>` and never move.
    // See `@noddle/shared/swarm-names`.
    swarmName: text("swarm_name").notNull(),

    /**
     * Optional Swarm service overrides (healthcheck, placement, …). `null`
     * = Noddle defaults. Exposed on Advanced → Cluster Settings.
     */
    swarmSettings: jsonb("swarm_settings").$type<DatabaseSwarmSettings>(),

    updatedAt,

    /**
     * Container path for the primary data volume. `null` = the engine's
     * pinned default (`ENGINE_SPECS.volumePath`). Editable so a major
     * Postgres bump (path layout change) can be matched without a rebuild.
     */
    volumePath: text("volume_path"),
  },
  (t) => [uniqueIndex("databases_env_name_idx").on(t.environmentId, t.name)]
);
