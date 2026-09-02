export function logChannel(deploymentId: string): string {
  return `noddle-logs:${deploymentId}`;
}

export function logBufferKey(deploymentId: string): string {
  return `noddle-logbuf:${deploymentId}`;
}

export function logSeqKey(deploymentId: string): string {
  return `noddle-logseq:${deploymentId}`;
}

export const LOG_BUFFER_MAX_ENTRIES = 2000;

export const LOG_BUFFER_TTL_SECONDS = 3600;

export const LOG_PUBLISH_SCRIPT = `local seq = redis.call('INCR', KEYS[2])
redis.call('EXPIRE', KEYS[2], ARGV[3])
local entry = cjson.decode(ARGV[1])
entry.seq = seq
local payload = cjson.encode(entry)
redis.call('RPUSH', KEYS[1], payload)
redis.call('LTRIM', KEYS[1], -tonumber(ARGV[2]), -1)
redis.call('EXPIRE', KEYS[1], ARGV[3])
redis.call('PUBLISH', ARGV[4], payload)
return seq`;

export type LogMessage =
  | { type: "chunk"; data: string }
  | { type: "end"; status: string };

export interface LogEntry {
  message: LogMessage;
  seq: number;
}

export function encodeLogMessage(message: LogMessage): string {
  return JSON.stringify(message);
}

function messageOf(candidate: Partial<LogMessage>): LogMessage | null {
  if (candidate.type === "chunk" && typeof candidate.data === "string") {
    return { data: candidate.data, type: "chunk" };
  }
  if (candidate.type === "end" && typeof candidate.status === "string") {
    return { status: candidate.status, type: "end" };
  }
  return null;
}

function seqOf(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : 0;
}

export function decodeLogEntry(raw: string): LogEntry | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const candidate = parsed as Partial<LogMessage> & { seq?: unknown };
    const message = messageOf(candidate);
    return message ? { message, seq: seqOf(candidate.seq) } : null;
  } catch {
    return null;
  }
}

const TERMINAL_STATUSES = new Set([
  "succeeded",
  "failed",
  "rolled_back",
  "reverted_by_watch",
]);

export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}
