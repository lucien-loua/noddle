/**
 * The `:` is allowed here. The known restriction only applies to BullMQ
 * queue names, which use it as a Redis key separator and refuse to start.
 * These are ordinary Redis keys, not queues.
 */
export function logChannel(deploymentId: string): string {
  return `noddle-logs:${deploymentId}`;
}

export function logBufferKey(deploymentId: string): string {
  return `noddle-logbuf:${deploymentId}`;
}

/**
 * The catch-up buffer is capped in NUMBER OF ENTRIES, not bytes. A Next.js
 * build produces tens of thousands of lines; keeping the latest window is
 * enough to understand where it stands, and the full log stays in the
 * file.
 */
export const LOG_BUFFER_MAX_ENTRIES = 2000;

/**
 * The buffer dies on its own. Without a TTL, every deployment would leave
 * its window in memory indefinitely — on a 2 GB VM, Redis would end up
 * fighting deployed applications for RAM.
 */
export const LOG_BUFFER_TTL_SECONDS = 3600;

export type LogMessage =
  | { type: "chunk"; data: string }
  /**
   * The deployment reached a terminal status. Without this message, an
   * SSE stream would stay open indefinitely after the build ends: the
   * client has no other way to distinguish "finished" from "silent".
   */
  | { type: "end"; status: string };

export function encodeLogMessage(message: LogMessage): string {
  return JSON.stringify(message);
}

/**
 * Returns `null` rather than throwing: an unreadable message on the
 * channel must not bring down a viewer's stream.
 */
export function decodeLogMessage(raw: string): LogMessage | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const candidate = parsed as Partial<LogMessage>;
    if (candidate.type === "chunk" && typeof candidate.data === "string") {
      return { data: candidate.data, type: "chunk" };
    }
    if (candidate.type === "end" && typeof candidate.status === "string") {
      return { status: candidate.status, type: "end" };
    }
    return null;
  } catch {
    return null;
  }
}

/** Statuses after which no more lines will arrive. */
const TERMINAL_STATUSES = new Set([
  "succeeded",
  "failed",
  "rolled_back",
  "reverted_by_watch",
]);

export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}
