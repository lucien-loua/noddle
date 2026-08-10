import { loadAppKey } from "@noddle/shared/crypto";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`required environment variable: ${name}`);
  }
  return value;
}

export const env = {
  appKey: loadAppKey(process.env.APP_KEY),
  databaseUrl: required("DATABASE_URL"),

  /**
   * Where the worker writes build logs. The web only touches it to re-read
   * a completed deployment: live streaming goes through Redis, never the disk.
   */
  logRoot: process.env.LOG_ROOT ?? "/var/lib/noddle/logs",

  redisUrl: required("REDIS_URL"),
} as const;
