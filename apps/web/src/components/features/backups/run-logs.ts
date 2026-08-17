import { formatLogStamp } from "@/components/terminal-logs";
import type { TerminalLogLine } from "@/components/terminal-logs";
import { byteSize } from "@/lib/format";

import type { BackupRunRow } from "./run-types";

function runLogLines(
  backup: BackupRunRow,
  startMessages: [string, string],
  completedMessages: [string, string, string],
  failedLabel: string,
  runningMessage: string,
): TerminalLogLine[] {
  const start = formatLogStamp(backup.createdAt);
  const end = formatLogStamp(backup.finishedAt ?? backup.createdAt);
  const texts: string[] = [`${start} ${startMessages[0]}`, `${start} ${startMessages[1]}`];

  if (backup.status === "completed") {
    texts.push(
      `${end} ${completedMessages[0]}`,
      `${end} ${completedMessages[1]}`,
      `${end} Object: ${backup.objectKey} (${byteSize(backup.sizeBytes)})`,
      completedMessages[2],
    );
  } else if (backup.status === "failed") {
    texts.push(
      `${end} ❌ Error: ${failedLabel}`,
      `Error: ${backup.errorMessage ?? "unknown error"}`,
    );
  } else if (backup.status === "running") {
    texts.push(`${start} ${runningMessage}`);
  } else {
    texts.push(`${start} Waiting to start...`);
  }

  return texts.map((text, index) => ({ id: String(index), text }));
}

export function databaseRunLogs(backup: BackupRunRow): TerminalLogLine[] {
  return runLogLines(
    backup,
    ["Starting backup process...", "Executing backup command..."],
    [
      "Starting backup and upload to S3...",
      "✅ Backup uploaded to S3 successfully",
      "Backup done ✅",
    ],
    "Backup failed",
    "Starting backup and upload to S3...",
  );
}

export function volumeRunLogs(backup: BackupRunRow): TerminalLogLine[] {
  return runLogLines(
    backup,
    ["Starting volume backup...", "Executing tar on the Docker volume..."],
    ["Uploading archive to S3...", "✅ Volume backup uploaded successfully", "Backup done ✅"],
    "Volume backup failed",
    "Uploading archive to S3...",
  );
}
