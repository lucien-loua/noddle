import { open, stat } from "node:fs/promises";

import { deploymentLogs, stackDeploymentLogs } from "@noddle/db/schema";
import { desc, eq } from "drizzle-orm";

import { db } from "@/lib/db.server";

/**
 * A Next.js build produces tens of thousands of lines. Returning the
 * entire file would freeze the tab; it's the END that says why a
 * deployment finished the way it did.
 */
const MAX_TAIL_BYTES = 1024 * 1024;

export async function readArchive(deploymentId: string): Promise<string | null> {
  // Service or stack: same pointer mechanism, two tables. We look first
  // on the service side, the common case.
  const [serviceRow] = await db
    .select()
    .from(deploymentLogs)
    .where(eq(deploymentLogs.deploymentId, deploymentId))
    .orderBy(desc(deploymentLogs.createdAt))
    .limit(1);
  const [stackRow] = serviceRow
    ? []
    : await db
        .select()
        .from(stackDeploymentLogs)
        .where(eq(stackDeploymentLogs.stackDeploymentId, deploymentId))
        .orderBy(desc(stackDeploymentLogs.createdAt))
        .limit(1);
  const pointer = serviceRow ?? stackRow;

  if (!pointer?.storageUrl.startsWith("file://")) {
    return null;
  }
  const path = pointer.storageUrl.slice("file://".length);

  try {
    const { size } = await stat(path);
    const start = Math.max(0, size - MAX_TAIL_BYTES);
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(size - start);
      await handle.read(buffer, 0, buffer.length, start);
      const text = buffer.toString("utf-8");
      return start > 0 ? `… ${start} earlier bytes omitted …\n${text}` : text;
    } finally {
      await handle.close();
    }
  } catch {
    // Missing file: the worker might be running on another machine, or
    // the volume isn't mounted. We say so rather than returning an empty
    // stream that would look like a build with no output.
    return null;
  }
}
