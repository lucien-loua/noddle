import type { ReactNode } from "react";
import { relativeTime } from "@/lib/format";
import type { VolumeRestoreTarget } from "./types";

export function volumeRestoreDescription(
  target: VolumeRestoreTarget | null
): ReactNode {
  if (target?.kind === "run") {
    return (
      <>
        The live volume data for this service will be{" "}
        <strong>permanently replaced</strong> by the archive taken{" "}
        {relativeTime(target.backup.createdAt)}. Noddle scales the service down,
        writes a safety backup first, then restores the tar archive.
      </>
    );
  }

  if (target?.kind === "object") {
    return (
      <>
        The live volume data for this service will be{" "}
        <strong>permanently replaced</strong> by{" "}
        <code className="text-xs">{target.objectKey}</code> into volume{" "}
        <code className="text-xs">{target.volumeName}</code>. Noddle scales the
        service down during the restore.
      </>
    );
  }

  return (
    <>
      The live volume data for this service will be{" "}
      <strong>permanently replaced</strong> by the selected archive. Noddle
      scales the service down during the restore.
    </>
  );
}
