import {
  decodeLogMessage,
  logBufferKey,
  logChannel,
} from "@noddle/shared/logs";
import type { LogMessage } from "@noddle/shared/logs";
import IORedis from "ioredis";

import { env } from "@/lib/env.server";

export type LogListener = (message: LogMessage) => void;

// Vite's hot reload re-evaluates this module on every edit. Without
// memoization on globalThis, every save would leave two orphaned Redis
// connections behind it.
const globalForRedis = globalThis as typeof globalThis & {
  __noddleRedis?: IORedis;
  __noddleLogHub?: LogHub;
};

export const redis: IORedis =
  globalForRedis.__noddleRedis ??
  new IORedis(env.redisUrl, { maxRetriesPerRequest: null });
globalForRedis.__noddleRedis = redis;

class LogHub {
  private readonly subscriber: IORedis;
  private readonly listeners = new Map<string, Set<LogListener>>();

  constructor(connection: IORedis) {
    this.subscriber = connection.duplicate();
    this.subscriber.on("message", (channel, raw) => {
      const message = decodeLogMessage(raw);
      if (!message) {
        // An unreadable message must not take down the viewers.
        return;
      }
      for (const listener of this.listeners.get(channel) ?? []) {
        listener(message);
      }
    });
  }

  /** Returns a way to unsubscribe. Call it when the SSE stream closes. */
  async subscribe(
    deploymentId: string,
    listener: LogListener
  ): Promise<() => void> {
    const channel = logChannel(deploymentId);
    let set = this.listeners.get(channel);

    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
      await this.subscriber.subscribe(channel);
    }
    set.add(listener);

    return () => {
      const current = this.listeners.get(channel);
      if (!current) {
        return;
      }
      current.delete(listener);
      if (current.size === 0) {
        this.listeners.delete(channel);
        this.subscriber.unsubscribe(channel).catch(() => {
          // the channel will disappear along with the connection
        });
      }
    };
  }

  /**
   * What has already scrolled by before this viewer arrived.
   *
   * Without this, opening the dashboard in the middle of a three-minute
   * build shows an empty screen until the next line — and Redis pub/sub,
   * being fire-and-forget, will never replay what has already happened.
   */
  // Part of the bus's interface; the module-level redis client is what it
  // reads, so it needs no `this`.
  async backlog(deploymentId: string): Promise<LogMessage[]> {
    const raw = await redis.lrange(logBufferKey(deploymentId), 0, -1);
    const messages: LogMessage[] = [];
    for (const entry of raw) {
      const message = decodeLogMessage(entry);
      if (message) {
        messages.push(message);
      }
    }
    return messages;
  }
}

export const logHub: LogHub =
  globalForRedis.__noddleLogHub ?? new LogHub(redis);
globalForRedis.__noddleLogHub = logHub;
