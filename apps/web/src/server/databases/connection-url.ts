import { connectionUrlFor } from '@noddle/database-spec';
import type { DatabaseEngine } from '@noddle/database-spec';

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
