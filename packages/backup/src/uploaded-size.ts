import { objectExists, objectSize } from "@noddle/backup-store";
import type { BackupDestination } from "@noddle/backup-store";

export async function uploadedSize(
  destination: BackupDestination,
  key: string
): Promise<number> {
  if (!(await objectExists(destination, key))) {
    throw new Error(
      `the upload finished but object ${key} is missing from the bucket`
    );
  }
  return await objectSize(destination, key);
}
