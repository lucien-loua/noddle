export interface DevStack {
  databaseUrl: string;
  redisUrl: string;
  s3: {
    accessKeyId: string;
    bucket: string;
    endpoint: string;
    secretAccessKey: string;
  };
}

const DATABASE_URL = "postgres://noddle:noddle@localhost:55432/noddle";
const REDIS_URL = "redis://localhost:56379";

const S3_ENDPOINT = "http://localhost:59000";

const S3_ACCESS_KEY = "rustfsadmin";
const S3_SECRET_KEY = "rustfsadmin";
const S3_BUCKET = "noddle-verify";

const DEV_STACK_PORTS: Record<string, string> = {
  DATABASE_URL: "55432",
  REDIS_URL: "56379",
  S3_ENDPOINT: "59000",
};

function portOf(url: string): string | null {
  try {
    return new URL(url).port || null;
  } catch {
    return null;
  }
}

function devStackUrl(name: keyof typeof DEV_STACK_PORTS, fallback: string) {
  const override = process.env[name];
  if (!override) {
    return fallback;
  }

  const expected = DEV_STACK_PORTS[name];
  const actual = portOf(override);
  if (actual !== expected) {
    throw new Error(
      `${name} does not point at the dev stack: expected port ${expected}, got ${actual ?? "none"}. The verify suites truncate every table they touch, so this refuses rather than defaults. Run \`bun run dev:stack\`, or map your instance to port ${expected}.`
    );
  }
  return override;
}

export function assertDevStack(): void {
  devStack();
}

export function devStack(): DevStack {
  return {
    databaseUrl: devStackUrl("DATABASE_URL", DATABASE_URL),
    redisUrl: devStackUrl("REDIS_URL", REDIS_URL),
    s3: {
      accessKeyId: process.env.S3_ACCESS_KEY ?? S3_ACCESS_KEY,
      bucket: process.env.S3_BUCKET ?? S3_BUCKET,
      endpoint: devStackUrl("S3_ENDPOINT", S3_ENDPOINT),
      secretAccessKey: process.env.S3_SECRET_KEY ?? S3_SECRET_KEY,
    },
  };
}
