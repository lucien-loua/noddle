import type { BackupDestination } from "@noddle/backup-store";
import { backupObjectKey } from "@noddle/backup-store";
import type { Database } from "@noddle/db";
import { s3Destinations } from "@noddle/db/schema";
import {
  decryptSecret,
  resolveRetainedSecret,
  secretContext,
} from "@noddle/shared/crypto";
import type { DatabaseEngine } from "@noddle/shared/database-engines";
import { eq } from "drizzle-orm";

/**
 * Dump file extension for an engine.
 *
 * Belongs to the BACKUP domain, not the database domain: it is a dumper choice
 * (`pg_dump -Fc`, `mysqldump`, `mongodump --archive`, `redis-cli --rdb`), not a
 * general engine property like its port or default image — so it does not
 * belong in `@noddle/shared/database-engines`.
 *
 * Single table: `apps/worker/src/backup.ts` (DUMP_SPECS) IMPORTS it instead of
 * redefining its own `extension` field. Before, this fact lived ONLY there — a
 * file the web cannot import (it pulls `#deploy`, hence `dockerode`/`ssh2`) —
 * and two other places (`triggerBackup`, `sweepBackups`) re-guessed it with a
 * `postgres ? "dump" : "rdb"` ternary. That ternary already gave a `.rdb` to a
 * SQL dump once (fixed in `restore.ts`); the other two occurrences had the same
 * defect, just never shown because no engine other than postgres/redis had yet
 * taken that exact path.
 */
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

/**
 * Joins the destination bucket prefix with an optional config-level prefix.
 */
export function joinBackupPrefix(
  destinationPrefix: string,
  configPrefix = ""
): string {
  return [destinationPrefix, configPrefix]
    .map((p) => p.replace(/^\/+|\/+$/g, ""))
    .filter((p) => p !== "")
    .join("/");
}

/**
 * Picks the destination for an operation, FROM the candidates.
 *
 * Pure function: no query, no encryption. This is the multi-destination choice
 * RULE, testable with plain arrays — it is what `verify.ts` exercises
 * exhaustively.
 *
 * `requestedId` comes from `backup_configs.destination_id` (for a backup being
 * launched) or from `backups.destination_id` (for a restore or retention purge
 * — there you need the ONE where the object actually went, not the one
 * configured today).
 *
 * `null`/`undefined` means "the one there is": a single-destination install
 * never has to choose. From TWO onward, we refuse explicitly rather than pick
 * one at random — writing a backup into the wrong bucket raises nothing, and
 * nobody would go looking for it there.
 */
export function pickDestination<T extends DestinationCandidate>(
  candidates: T[],
  requestedId?: string | null
): T {
  if (requestedId) {
    const chosen = candidates.find((c) => c.id === requestedId);
    if (!chosen) {
      throw new Error(
        "the S3 destination this backup used no longer exists — restore and retention cannot know where its object lives"
      );
    }
    return chosen;
  }

  const [only, ...rest] = candidates;
  if (!only) {
    throw new Error("no S3 destination configured — add one before backing up");
  }
  if (rest.length > 0) {
    throw new Error(
      "several S3 destinations exist — pick one for this database before backing up"
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

/**
 * The chosen row, WITHOUT the secret — everything needed to build an object
 * key. Used by the web (never decrypts) and by the worker upstream of
 * decryption.
 */
export async function resolveDestinationRow(
  db: Database,
  requestedId?: string | null
): Promise<DestinationCandidate> {
  const rows = await candidateRows(db, requestedId);
  return pickDestination(rows, requestedId);
}

/**
 * The chosen destination, secret decrypted — reserved for the worker: it is
 * the one that actually talks to S3.
 *
 * AAD stays `backup_destination:<id>` despite the table rename
 * (`backup_destinations` → `s3_destinations`, 2026-08-06): it is AUTHENTICATED,
 * changing it would make every already-stored key undecryptable.
 */
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

/**
 * The row for a backup to create, destination and object key DECIDED TOGETHER.
 *
 * A single call decides both at once so they can no longer diverge between
 * enqueue time and upload time.
 */
export function buildBackupInsert(opts: {
  configId?: string | null;
  /** Extra path under the destination prefix (from the backup config). */
  configPrefix?: string;
  database: { engine: DatabaseEngine; id: string; name: string };
  /** Override the key path segment / dump target name. */
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
