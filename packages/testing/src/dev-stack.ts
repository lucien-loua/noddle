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

export function devStack(): DevStack {
  return {
    databaseUrl: process.env.DATABASE_URL ?? DATABASE_URL,
    redisUrl: process.env.REDIS_URL ?? REDIS_URL,
    s3: {
      accessKeyId: process.env.S3_ACCESS_KEY ?? S3_ACCESS_KEY,
      bucket: process.env.S3_BUCKET ?? S3_BUCKET,
      endpoint: process.env.S3_ENDPOINT ?? S3_ENDPOINT,
      secretAccessKey: process.env.S3_SECRET_KEY ?? S3_SECRET_KEY,
    },
  };
}
