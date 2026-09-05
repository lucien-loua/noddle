import { loadAppKey } from "@noddle/crypto";

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

  redisUrl: required("REDIS_URL"),
} as const;
