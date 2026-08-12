import type { VolumeBackupRow } from "@/server/volume-backups";

export type VolumeRestoreTarget =
  | { backup: VolumeBackupRow; kind: "run" }
  | {
      destinationId: string;
      kind: "object";
      objectKey: string;
      volumeName: string;
    };
