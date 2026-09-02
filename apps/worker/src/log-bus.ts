import {
  encodeLogMessage,
  LOG_BUFFER_MAX_ENTRIES,
  LOG_BUFFER_TTL_SECONDS,
  LOG_PUBLISH_SCRIPT,
  logBufferKey,
  logChannel,
  logSeqKey,
} from "@noddle/shared/logs";
import type { LogMessage } from "@noddle/shared/logs";
import type IORedis from "ioredis";

export interface LogBus {
  close: () => Promise<void>;
  publish: (deploymentId: string, message: LogMessage) => void;
}

type LogPublisher = IORedis & {
  noddlePublishLog: (
    bufferKey: string,
    seqKey: string,
    payload: string,
    maxEntries: string,
    ttlSeconds: string,
    channel: string
  ) => Promise<number>;
};

export function createLogBus(connection: IORedis): LogBus {
  const publisher = connection.duplicate();
  publisher.defineCommand("noddlePublishLog", {
    lua: LOG_PUBLISH_SCRIPT,
    numberOfKeys: 2,
  });

  return {
    async close() {
      await publisher.quit();
    },

    publish(deploymentId, message) {
      (publisher as LogPublisher)
        .noddlePublishLog(
          logBufferKey(deploymentId),
          logSeqKey(deploymentId),
          encodeLogMessage(message),
          String(LOG_BUFFER_MAX_ENTRIES),
          String(LOG_BUFFER_TTL_SECONDS),
          logChannel(deploymentId)
        )
        .catch(() => {});
    },
  };
}
