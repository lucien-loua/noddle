import { resolveDestination } from "@noddle/backup";
import { deleteObject } from "@noddle/backup-store";
import { s3Destinations } from "@noddle/db/schema";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db.server";
import { env } from "@/lib/env.server";

import type { BackupRunRow } from "./policy";

export async function assertDestinationExists(
  destinationId: string
): Promise<void> {
  const destination = await db.query.s3Destinations.findFirst({
    where: eq(s3Destinations.id, destinationId),
  });
  if (!destination) {
    throw new Error("S3 destination not found");
  }
}

export async function deleteBackupRun(
  run: {
    destinationId: string | null;
    objectKey: string;
    status: BackupRunRow["status"];
  },
  dropRow: () => Promise<unknown>
): Promise<{ ok: true }> {
  if (run.status === "queued" || run.status === "running") {
    throw new Error("cannot delete a backup that is still in progress");
  }

  if (run.destinationId) {
    try {
      const { destination } = await resolveDestination(
        db,
        env.appKey,
        run.destinationId
      );
      await deleteObject(destination, run.objectKey);
    } catch {}
  }

  await dropRow();
  return { ok: true as const };
}
