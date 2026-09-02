export interface BackupRunRow {
  configId: string | null;
  createdAt: string;
  errorMessage: string | null;
  finishedAt: string | null;
  id: string;
  kind: "manual" | "pre_restore" | "scheduled";
  objectKey: string;
  sizeBytes: number;
  status: "completed" | "failed" | "queued" | "running";
}

interface BackupRunRecord {
  configId: string | null;
  createdAt: Date;
  errorMessage: string | null;
  finishedAt: Date | null;
  id: string;
  kind: BackupRunRow["kind"];
  objectKey: string;
  sizeBytes: number;
  status: BackupRunRow["status"];
}

export function toBackupRunRow(run: BackupRunRecord): BackupRunRow {
  return {
    configId: run.configId,
    createdAt: run.createdAt.toISOString(),
    errorMessage: run.errorMessage,
    finishedAt: run.finishedAt?.toISOString() ?? null,
    id: run.id,
    kind: run.kind,
    objectKey: run.objectKey,
    sizeBytes: run.sizeBytes,
    status: run.status,
  };
}

export function assertRestorableRun<
  T extends { status: BackupRunRow["status"] },
>(
  run: T | undefined,
  belongsToOwner: boolean,
  label: { noun: string; owner: string }
): asserts run is T {
  if (!run || !belongsToOwner) {
    throw new Error(`${label.noun} not found for this ${label.owner}`);
  }
  if (run.status !== "completed") {
    throw new Error(
      `only a completed ${label.noun} can be restored, and this one is not`
    );
  }
}
