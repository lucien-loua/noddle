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
