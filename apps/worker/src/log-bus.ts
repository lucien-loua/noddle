import {
  encodeLogMessage,
  LOG_BUFFER_MAX_ENTRIES,
  LOG_BUFFER_TTL_SECONDS,
  type LogMessage,
  logBufferKey,
  logChannel,
} from "@noddle/shared/logs";
import type IORedis from "ioredis";

export interface LogBus {
  close: () => Promise<void>;
  /** Non-blocking: a deployment must never wait on the dashboard. */
  publish: (deploymentId: string, message: LogMessage) => void;
}

export function createLogBus(connection: IORedis): LogBus {
  // DEDICATED connection. A BullMQ Worker occupies its own with blocking
  // reads; a publish queued behind one of those would arrive in the
  // dashboard seconds late.
  const publisher = connection.duplicate();

  return {
    async close() {
      await publisher.quit();
    },

    publish(deploymentId, message) {
      const payload = encodeLogMessage(message);
      const channel = logChannel(deploymentId);
      const bufferKey = logBufferKey(deploymentId);

      // The live stream AND the catch-up buffer in the same round trip.
      const pipeline = publisher
        .multi()
        .publish(channel, payload)
        .rpush(bufferKey, payload)
        .ltrim(bufferKey, -LOG_BUFFER_MAX_ENTRIES, -1)
        .expire(bufferKey, LOG_BUFFER_TTL_SECONDS);

      // An unavailable Redis must not interrupt a build in progress: the file
      // remains the source of truth, the dashboard is only a watcher.
      pipeline.exec().catch(() => {
        // intentionally ignored
      });
    },
  };
}
