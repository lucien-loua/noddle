import type { BackupDestination } from "@noddle/backup-store";
import { backupObjectKey, volumeBackupObjectKey } from "@noddle/backup-store";
import {
  decryptSecret,
  resolveRetainedSecret,
  secretContext,
} from "@noddle/crypto";
import type { DatabaseEngine } from "@noddle/database-spec";
import type { Database } from "@noddle/db";
import { s3Destinations } from "@noddle/db/schema";
import { eq } from "drizzle-orm";

export const BACKUP_EXTENSION: Record<DatabaseEngine, string> = {
  mariadb: "sql",
  mongo: "archive.gz",
  mysql: "sql",
  postgres: "dump",
  redis: "rdb",
};

export interface DestinationCandidate {
  id: string;
  prefix: string;
}

export function joinBackupPrefix(
  destinationPrefix: string,
  configPrefix = ""
): string {
  return [destinationPrefix, configPrefix]
    .map((p) => p.replaceAll(/^\/+|\/+$/g, ""))
    .filter((p) => p !== "")
    .join("/");
}

export function pickDestination<T extends DestinationCandidate>(
  candidates: T[],
  requestedId?: string | null
): T {
  if (requestedId) {
    const chosen = candidates.find((c) => c.id === requestedId);
    if (!chosen) {
      throw new Error(
        "the S3 destination this backup used no longer exists: restore and retention cannot know where its object lives"
      );
    }
    return chosen;
  }

  const [only, ...rest] = candidates;
  if (!only) {
    throw new Error("no S3 destination configured: add one before backing up");
  }
  if (rest.length > 0) {
    throw new Error(
      "several S3 destinations exist: pick one for this database before backing up"
    );
  }
  return only;
}

type DestinationRow = typeof s3Destinations.$inferSelect;

async function candidateRows(
  db: Database,
  requestedId?: string | null
): Promise<DestinationRow[]> {
  return requestedId
    ? await db.query.s3Destinations.findMany({
        where: eq(s3Destinations.id, requestedId),
      })
    : await db.query.s3Destinations.findMany();
}

export async function resolveDestinationRow(
  db: Database,
  requestedId?: string | null
): Promise<DestinationCandidate> {
  const rows = await candidateRows(db, requestedId);
  return pickDestination(rows, requestedId);
}

export async function resolveDestination(
  db: Database,
  appKey: Buffer,
  requestedId?: string | null
): Promise<{ destination: BackupDestination; id: string }> {
  const rows = await candidateRows(db, requestedId);
  const row = pickDestination(rows, requestedId);
  return {
    destination: {
      accessKeyId: row.accessKeyId,
      bucket: row.bucket,
      endpoint: row.endpoint,
      forcePathStyle: row.forcePathStyle,
      prefix: row.prefix,
      region: row.region,
      secretAccessKey: decryptSecret(
        row.secretAccessKeyEncrypted,
        appKey,
        secretContext.backupDestination(row.id)
      ),
    },
    id: row.id,
  };
}

export async function resolveDestinationSecret(
  db: Database,
  appKey: Buffer,
  data: { id?: string; secretAccessKey: string }
): Promise<string> {
  return await resolveRetainedSecret(
    data.secretAccessKey,
    async () => {
      if (!data.id) {
        return null;
      }
      const existing = await db.query.s3Destinations.findFirst({
        where: eq(s3Destinations.id, data.id),
      });
      if (!existing) {
        return null;
      }
      return decryptSecret(
        existing.secretAccessKeyEncrypted,
        appKey,
        secretContext.backupDestination(existing.id)
      );
    },
    "A secret access key is required."
  );
}

export type BackupKind = "manual" | "pre_restore" | "scheduled";

export interface BackupInsertValues {
  configId?: string | null;
  databaseId: string;
  destinationId: string;
  kind: BackupKind;
  objectKey: string;
}

export function buildBackupInsert(opts: {
  configId?: string | null;
  configPrefix?: string;
  database: { engine: DatabaseEngine; id: string; name: string };
  databaseName?: string;
  kind: BackupKind;
  resolved: DestinationCandidate;
  takenAt?: Date;
}): BackupInsertValues {
  const prefix = joinBackupPrefix(
    opts.resolved.prefix,
    opts.configPrefix ?? ""
  );
  return {
    configId: opts.configId ?? null,
    databaseId: opts.database.id,
    destinationId: opts.resolved.id,
    kind: opts.kind,
    objectKey: backupObjectKey({
      backupId: crypto.randomUUID(),
      databaseName: opts.databaseName ?? opts.database.name,
      extension: BACKUP_EXTENSION[opts.database.engine],
      prefix,
      takenAt: opts.takenAt ?? new Date(),
    }),
  };
}

export interface VolumeBackupInsertValues {
  configId?: string | null;
  destinationId: string;
  kind: BackupKind;
  objectKey: string;
  serviceId: string;
  volumeName: string;
}

export function buildVolumeBackupInsert(opts: {
  configId?: string | null;
  configPrefix?: string;
  kind: BackupKind;
  resolved: DestinationCandidate;
  service: { id: string; name: string };
  takenAt?: Date;
  volumeName: string;
}): VolumeBackupInsertValues {
  const prefix = joinBackupPrefix(
    opts.resolved.prefix,
    opts.configPrefix ?? ""
  );
  return {
    configId: opts.configId ?? null,
    destinationId: opts.resolved.id,
    kind: opts.kind,
    objectKey: volumeBackupObjectKey({
      backupId: crypto.randomUUID(),
      prefix,
      serviceName: opts.service.name,
      takenAt: opts.takenAt ?? new Date(),
      volumeName: opts.volumeName,
    }),
    serviceId: opts.service.id,
    volumeName: opts.volumeName,
  };
}
