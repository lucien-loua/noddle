import { open, stat } from "node:fs/promises";

import { deploymentLogs, stackDeploymentLogs } from "@noddle/db/schema";
import { desc, eq } from "drizzle-orm";

import { db } from "@/lib/db.server";

const MAX_TAIL_BYTES = 1024 * 1024;
const FILE_URL = "file://";

export type LogArchive =
  | { kind: "none" }
  | { kind: "text"; text: string }
  | { kind: "unreadable"; path: string };

async function findPointer(deploymentId: string) {
  const [serviceRow] = await db
    .select()
    .from(deploymentLogs)
    .where(eq(deploymentLogs.deploymentId, deploymentId))
    .orderBy(desc(deploymentLogs.createdAt))
    .limit(1);
  if (serviceRow) {
    return serviceRow;
  }
  const [stackRow] = await db
    .select()
    .from(stackDeploymentLogs)
    .where(eq(stackDeploymentLogs.stackDeploymentId, deploymentId))
    .orderBy(desc(stackDeploymentLogs.createdAt))
    .limit(1);
  return stackRow;
}

async function readTail(path: string): Promise<string> {
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
}

export async function readArchive(deploymentId: string): Promise<LogArchive> {
  const pointer = await findPointer(deploymentId);
  if (!pointer?.storageUrl.startsWith(FILE_URL)) {
    return { kind: "none" };
  }

  const path = pointer.storageUrl.slice(FILE_URL.length);
  try {
    return { kind: "text", text: await readTail(path) };
  } catch {
    return { kind: "unreadable", path };
  }
}
