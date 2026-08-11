import type { BackupRow } from "@/server/backups";

export type RestoreTarget =
  | { backup: BackupRow; kind: "run" }
  | { kind: "object"; objectKey: string; destinationId: string };
