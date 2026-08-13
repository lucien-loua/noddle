import type { BackupRunRow } from "@/components/features/backups/run-types";

export type BackupRestoreTarget =
  | { backup: BackupRunRow; kind: "run" }
  | {
      destinationId: string;
      kind: "object";
      objectKey: string;
      volumeName?: string;
    };
