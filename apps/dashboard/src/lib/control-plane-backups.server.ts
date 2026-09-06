import { listObjects, resolveDestination } from "@noddle/backup";

import { db } from "@/lib/db.server";
import { env } from "@/lib/env.server";

const CONTROL_PLANE_FOLDER = "noddle-control-plane";

export async function listControlPlaneBackups(
  destinationId: string
): Promise<{ key: string; size: number; takenAt: string }[]> {
  const { destination } = await resolveDestination(
    db,
    env.appKey,
    destinationId
  );
  const objects = await listObjects(destination, {
    prefix: CONTROL_PLANE_FOLDER,
  });
  return objects
    .map((object) => ({
      key: object.key,
      size: object.sizeBytes,
      takenAt: object.lastModified ?? "",
    }))
    .toSorted((a, b) => b.takenAt.localeCompare(a.takenAt));
}
