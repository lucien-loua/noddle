export const DATABASE_ENGINES = [
  "postgres",
  "mysql",
  "mariadb",
  "mongo",
  "redis",
] as const;

export type DatabaseEngine = (typeof DATABASE_ENGINES)[number];

/**
 * The default admin user: the name of the ENGINE, never the product's.
 *
 * `null` for engines with no notion of a user.
 */
export const DEFAULT_DATABASE_USER: Record<DatabaseEngine, string | null> = {
  mariadb: "mariadb",
  mongo: "mongo",
  mysql: "mysql",
  postgres: "postgres",
  redis: null,
};

/** Does the engine have a NAMED database, distinct from its server? */
export const HAS_NAMED_DATABASE: Record<DatabaseEngine, boolean> = {
  mariadb: true,
  mongo: true,
  mysql: true,
  postgres: true,
  redis: false,
};

/** The displayed label. Separate from the technical name, which is a key, not a word. */
export const DATABASE_ENGINE_LABEL: Record<DatabaseEngine, string> = {
  mariadb: "MariaDB",
  mongo: "MongoDB",
  mysql: "MySQL",
  postgres: "PostgreSQL",
  redis: "Redis",
};

/**
 * The prefix the engine reserves for itself in the container's environment.
 *
 * Used by the worker on merge and by the web app to reject reserved keys.
 */
export const ENGINE_ENV_PREFIX: Record<DatabaseEngine, string> = {
  mariadb: "MARIADB_",
  mongo: "MONGO_",
  mysql: "MYSQL_",
  postgres: "POSTGRES_",
  redis: "REDIS_",
};
