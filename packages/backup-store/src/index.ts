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

const PART_SIZE = 8 * 1024 * 1024;
const QUEUE_SIZE = 2;
const VOLUME_NAME_FROM_OBJECT_KEY = /\/([^/]+)\/[^/]+\.tar\.gz$/;

export interface BackupDestination {
  accessKeyId: string;
  bucket: string;
  endpoint: string;
  forcePathStyle: boolean;
  prefix: string;
  region: string;
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

export function backupObjectKey(opts: {
  backupId: string;
  databaseName: string;
  extension: string;
  prefix: string;
  takenAt: Date;
}): string {
  const stamp = opts.takenAt.toISOString().replaceAll(/[:.]/g, "-");
  const name = `${stamp}-${opts.backupId}.${opts.extension}`;
  const parts = [opts.prefix, opts.databaseName, name].filter((p) => p !== "");
  return parts.join("/");
}

export function volumeBackupObjectKey(opts: {
  backupId: string;
  prefix: string;
  serviceName: string;
  takenAt: Date;
  volumeName: string;
}): string {
  const stamp = opts.takenAt.toISOString().replaceAll(/[:.]/g, "-");
  const name = `${stamp}-${opts.backupId}.tar.gz`;
  const parts = [opts.prefix, opts.serviceName, opts.volumeName, name].filter(
    (p) => p !== ""
  );
  return parts.join("/");
}

export function parseVolumeNameFromObjectKey(objectKey: string): string | null {
  const match = objectKey.match(VOLUME_NAME_FROM_OBJECT_KEY);
  return match?.[1] ?? null;
}

export async function checkDestination(
  destination: BackupDestination
): Promise<void> {
  const client = clientFor(destination);
  const key = [destination.prefix, `.noddle-check-${Date.now()}`]
    .filter((p) => p !== "")
    .join("/");

  try {
    await client.send(new HeadBucketCommand({ Bucket: destination.bucket }));
  } catch (error) {
    const status = httpStatus(error);
    if (status === 403) {
      throw new BackupStoreError(
        "credentials rejected: check the access key and secret key",
        {
          cause: error,
        }
      );
    }
    if (status === 404) {
      throw new BackupStoreError(
        `bucket "${destination.bucket}" not found on ${destination.endpoint}`,
        { cause: error }
      );
    }
    throw new BackupStoreError(
      `bucket "${destination.bucket}" unreachable: ${describe(error)}`,
      {
        cause: error,
      }
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
  } catch (error) {
    throw new BackupStoreError(
      `write refused in "${destination.bucket}": ${describe(error)}`,
      {
        cause: error,
      }
    );
  }

  try {
    await client.send(
      new DeleteObjectCommand({ Bucket: destination.bucket, Key: key })
    );
  } catch (error) {
    throw new BackupStoreError(
      `delete refused in "${destination.bucket}": ${describe(error)}. Old backups cannot be purged`,
      { cause: error }
    );
  }
}

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

export async function objectExists(
  destination: BackupDestination,
  key: string
): Promise<boolean> {
  try {
    await objectSize(destination, key);
    return true;
  } catch (error) {
    if (error instanceof NotFound || error instanceof NoSuchKey) {
      return false;
    }
    throw new BackupStoreError(
      `unable to verify object ${key}: ${describe(error)}`,
      {
        cause: error,
      }
    );
  }
}

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
  } catch (error) {
    throw new BackupStoreError(
      `unable to list objects in "${destination.bucket}": ${describe(error)}`,
      { cause: error }
    );
  }
}

function httpStatus(err: unknown): number | undefined {
  return (err as { $metadata?: { httpStatusCode?: number } }).$metadata
    ?.httpStatusCode;
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    return `${err.name}: ${err.message}`;
  }
  return String(err);
}
