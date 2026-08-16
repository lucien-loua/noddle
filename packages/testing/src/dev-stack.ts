/**
 * The addresses of the local development stack — the one `compose.dev.yml`
 * starts.
 *
 * These three URLs used to be a literal repeated in 27 files, which meant the
 * shape of the stack was something you reconstructed by reading fallback
 * expressions. Moving the port, the role or the bucket had to happen 27 times
 * or not at all.
 *
 * The environment still wins, exactly as before: every caller read
 * `process.env` first and fell back to a literal. Only the literal moved.
 *
 * This is NOT a target server. Those are Multipass VMs over real SSH at 2 GB
 * (ADR-0016), and nothing here substitutes for one.
 */

export type DevStack = {
  databaseUrl: string;
  redisUrl: string;
  s3: {
    accessKeyId: string;
    bucket: string;
    endpoint: string;
    secretAccessKey: string;
  };
};

/**
 * The role is `noddle`, matching production. The postgres image only creates
 * the role named by `POSTGRES_USER`, so the superuser this used to rely on
 * does not exist on an installed Noddle — a DSN copied across failed with
 * `role "postgres" does not exist`, which does not say why.
 */
const DATABASE_URL = "postgres://noddle:noddle@localhost:55432/noddle";
const REDIS_URL = "redis://localhost:56379";

/**
 * 59000, not 9000. The 5xxxx prefix means "this belongs to Noddle's local
 * development", so an S3 you already run on 9000 keeps working — and on this
 * kind of machine something usually does.
 */
const S3_ENDPOINT = "http://localhost:59000";

/** RustFS's own documented defaults, which is why the image tag is what fixes them. */
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
