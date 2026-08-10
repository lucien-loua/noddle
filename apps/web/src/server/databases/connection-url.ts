import {
  DATABASE_PORT,
  type DatabaseEngine,
} from "@noddle/shared/database-engines";

function buildConnectionUrl(
  engine: DatabaseEngine,
  host: string,
  secret: string,
  rootUser: string | null,
  databaseName: string | null,
  portOverride?: number
): string {
  const port = portOverride ?? DATABASE_PORT[engine];
  const dbName = databaseName ?? rootUser;

  switch (engine) {
    case "postgres":
      return `postgresql://${rootUser}:${secret}@${host}:${port}/${dbName}`;
    case "mariadb":
    case "mysql":
      return `mysql://${rootUser}:${secret}@${host}:${port}/${dbName}`;
    case "mongo":
      return `mongodb://${rootUser}:${secret}@${host}:${port}/${dbName}?authSource=admin`;
    default:
      return `redis://default:${secret}@${host}:${port}`;
  }
}

const MASK = "••••••••";

export function connectionString(
  engine: DatabaseEngine,
  host: string,
  password: string,
  rootUser: string | null,
  databaseName: string | null,
  portOverride?: number
): string {
  return buildConnectionUrl(
    engine,
    host,
    encodeURIComponent(password),
    rootUser,
    databaseName,
    portOverride
  );
}

export function maskedConnectionString(
  engine: DatabaseEngine,
  host: string,
  rootUser: string | null,
  databaseName: string | null,
  portOverride?: number
): string {
  return buildConnectionUrl(
    engine,
    host,
    MASK,
    rootUser,
    databaseName,
    portOverride
  );
}
