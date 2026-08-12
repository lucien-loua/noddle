import {
  connectionUrlFor,
  type DatabaseEngine,
} from "@noddle/shared/database-engines";

const MASK = "••••••••";

export function connectionString(
  engine: DatabaseEngine,
  host: string,
  password: string,
  rootUser: string | null,
  databaseName: string | null,
  portOverride?: number
): string {
  return connectionUrlFor(engine, {
    databaseName,
    host,
    password: encodeURIComponent(password),
    portOverride,
    rootUser,
  });
}

export function maskedConnectionString(
  engine: DatabaseEngine,
  host: string,
  rootUser: string | null,
  databaseName: string | null,
  portOverride?: number
): string {
  return connectionUrlFor(engine, {
    databaseName,
    host,
    password: MASK,
    portOverride,
    rootUser,
  });
}
