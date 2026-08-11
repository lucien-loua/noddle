import type { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  NotFound,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";

/**
 * 8 MiB per part and two parts in flight: upload memory is capped at ~16 MiB
 * regardless of dump size. This control plane shares a 2 GB machine with the
 * apps it deploys; leaving the SDK on its defaults would make the worker's
 * footprint depend on the user's database size.
 */
const PART_SIZE = 8 * 1024 * 1024;
const QUEUE_SIZE = 2;

export interface BackupDestination {
  accessKeyId: string;
  bucket: string;
  endpoint: string;
  forcePathStyle: boolean;
  prefix: string;
  region: string;
  /** Plaintext. Decrypted as close to use as possible, never logged. */
  secretAccessKey: string;
}

export class BackupStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BackupStoreError";
  }
}

function clientFor(destination: BackupDestination): S3Client {
  return new S3Client({
    credentials: {
      accessKeyId: destination.accessKeyId,
      secretAccessKey: destination.secretAccessKey,
    },
    endpoint: destination.endpoint,
    forcePathStyle: destination.forcePathStyle,
    region: destination.region,
  });
}

/**
 * Builds the object key for a backup.
 *
 * The backup id is included, not only the timestamp: two backups of the same
 * database in the same second would silently overwrite each other, and a
 * backup overwriting another is precisely what we cannot afford here.
 */
export function backupObjectKey(opts: {
  backupId: string;
  databaseName: string;
  extension: string;
  prefix: string;
  takenAt: Date;
}): string {
  const stamp = opts.takenAt.toISOString().replace(/[:.]/g, "-");
  const name = `${stamp}-${opts.backupId}.${opts.extension}`;
  const parts = [opts.prefix, opts.databaseName, name].filter((p) => p !== "");
  return parts.join("/");
}

/**
 * Proves a destination for real: a full write → read → delete round-trip, not
 * just a HEAD on the bucket.
 *
 * The distinction matters. Many providers grant bucket read to a key that
 * cannot write; a test that stops at HEAD would declare the destination good,
 * and the user would only find out on their first real backup — i.e. at the
 * worst moment, when they believe they are protected.
 */
export async function checkDestination(
  destination: BackupDestination
): Promise<void> {
  const client = clientFor(destination);
  const key = [destination.prefix, `.noddle-check-${Date.now()}`]
    .filter((p) => p !== "")
    .join("/");

  try {
    await client.send(new HeadBucketCommand({ Bucket: destination.bucket }));
  } catch (err) {
    // HeadBucket responds WITHOUT a body: the SDK then has neither an S3 code
    // nor message to surface and returns "UnknownError". As-is, a wrong secret
    // key showed up as "bucket unreachable: Unknown: UnknownError", which
    // blames the wrong field AND teaches nothing. The HTTP status, however, is
    // always there. Observed in a real browser, not with curl.
    const status = httpStatus(err);
    if (status === 403) {
      throw new BackupStoreError(
        "credentials rejected: check the access key and secret key",
        { cause: err }
      );
    }
    if (status === 404) {
      throw new BackupStoreError(
        `bucket "${destination.bucket}" not found on ${destination.endpoint}`,
        { cause: err }
      );
    }
    throw new BackupStoreError(
      `bucket "${destination.bucket}" unreachable: ${describe(err)}`,
      { cause: err }
    );
  }

  try {
    await client.send(
      new PutObjectCommand({
        Body: "noddle",
        Bucket: destination.bucket,
        Key: key,
      })
    );
  } catch (err) {
    throw new BackupStoreError(
      `write refused in "${destination.bucket}": ${describe(err)}`,
      { cause: err }
    );
  }

  try {
    await client.send(
      new DeleteObjectCommand({ Bucket: destination.bucket, Key: key })
    );
  } catch (err) {
    throw new BackupStoreError(
      `delete refused in "${destination.bucket}": ${describe(err)} — old backups cannot be purged`,
      { cause: err }
    );
  }
}

/**
 * Uploads a stream of UNKNOWN size, multipart.
 *
 * Returns the size re-read via HEAD, never the count of bytes seen passing
 * through: what matters is what the bucket holds, not what we think we sent.
 *
 * Measured against RustFS — if the stream EMITS an error, the SDK aborts the
 * multipart upload: no object is published and no upload is left open. There
 * is therefore nothing to clean up on that path. By contrast, a stream that
 * ends CLEANLY but truncated produces a perfectly valid object with wrong
 * content, which nothing here can detect: the caller must read the dumper's
 * exit code.
 */
export async function uploadStream(
  destination: BackupDestination,
  key: string,
  body: Readable
): Promise<number> {
  const client = clientFor(destination);
  const upload = new Upload({
    client,
    params: { Body: body, Bucket: destination.bucket, Key: key },
    partSize: PART_SIZE,
    queueSize: QUEUE_SIZE,
  });

  await upload.done();
  return await objectSize(destination, key);
}

/** Object size, or `null` if it does not exist. */
export async function objectSize(
  destination: BackupDestination,
  key: string
): Promise<number> {
  const client = clientFor(destination);
  const head = await client.send(
    new HeadObjectCommand({ Bucket: destination.bucket, Key: key })
  );
  return head.ContentLength ?? 0;
}

/**
 * True if the object is actually in the bucket.
 *
 * Called before every restore: the `backups` table says what Noddle wrote, the
 * bucket says what is STILL there. Someone may have purged the bucket by hand,
 * and discovering a missing object AFTER wiping the current database would be
 * the worst possible sequence.
 */
export async function objectExists(
  destination: BackupDestination,
  key: string
): Promise<boolean> {
  try {
    await objectSize(destination, key);
    return true;
  } catch (err) {
    if (err instanceof NotFound || err instanceof NoSuchKey) {
      return false;
    }
    throw new BackupStoreError(
      `unable to verify object ${key}: ${describe(err)}`,
      { cause: err }
    );
  }
}

/** Opens the object for reading. The body is a stream: never loaded into memory. */
export async function downloadStream(
  destination: BackupDestination,
  key: string
): Promise<Readable> {
  const client = clientFor(destination);
  const res = await client.send(
    new GetObjectCommand({ Bucket: destination.bucket, Key: key })
  );
  if (!res.Body) {
    throw new BackupStoreError(`empty or unreadable object: ${key}`);
  }
  return res.Body as Readable;
}

export async function deleteObject(
  destination: BackupDestination,
  key: string
): Promise<void> {
  const client = clientFor(destination);
  await client.send(
    new DeleteObjectCommand({ Bucket: destination.bucket, Key: key })
  );
}

export interface ListedBackupObject {
  key: string;
  lastModified: string | null;
  sizeBytes: number;
}

const KNOWN_DUMP_SUFFIXES = [".archive.gz", ".dump", ".rdb", ".sql"] as const;

function isKnownDumpKey(key: string): boolean {
  return KNOWN_DUMP_SUFFIXES.some((suffix) => key.endsWith(suffix));
}

/**
 * Lists objects under a prefix. Used when restoring from a dump that
 * may not appear in Noddle's run history (uploaded elsewhere, or pruned
 * from the DB while still in the bucket).
 *
 * Caps at 500 keys: a restore picker is not a bucket browser.
 */
export async function listObjects(
  destination: BackupDestination,
  opts?: { maxKeys?: number; prefix?: string }
): Promise<ListedBackupObject[]> {
  const client = clientFor(destination);
  const prefixParts = [destination.prefix, opts?.prefix ?? ""].filter(
    (p) => p !== ""
  );
  const prefix = prefixParts.join("/");
  const maxKeys = Math.min(Math.max(opts?.maxKeys ?? 200, 1), 500);

  try {
    const res = await client.send(
      new ListObjectsV2Command({
        Bucket: destination.bucket,
        MaxKeys: maxKeys,
        Prefix: prefix === "" ? undefined : prefix,
      })
    );
    return (res.Contents ?? [])
      .filter((obj): obj is typeof obj & { Key: string } => Boolean(obj.Key))
      .filter((obj) => isKnownDumpKey(obj.Key))
      .map((obj) => ({
        key: obj.Key,
        lastModified: obj.LastModified?.toISOString() ?? null,
        sizeBytes: obj.Size ?? 0,
      }));
  } catch (err) {
    throw new BackupStoreError(
      `unable to list objects in "${destination.bucket}": ${describe(err)}`,
      { cause: err }
    );
  }
}

/**
 * HTTP status carried by an SDK error.
 *
 * Often the ONLY usable information: several S3 responses (HeadBucket,
 * HeadObject) have no body, hence no S3 error code to read, and the SDK falls
 * back to "UnknownError".
 */
function httpStatus(err: unknown): number | undefined {
  return (err as { $metadata?: { httpStatusCode?: number } }).$metadata
    ?.httpStatusCode;
}

/**
 * Readable message without leaking the secret key.
 *
 * SDK errors carry the signed request in their metadata; logging them as-is
 * would write credentials into the logs.
 */
function describe(err: unknown): string {
  if (err instanceof Error) {
    return `${err.name}: ${err.message}`;
  }
  return String(err);
}
