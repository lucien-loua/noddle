import { decodeLogEntry, logBufferKey, logChannel } from "@noddle/shared/logs";
import type { LogEntry } from "@noddle/shared/logs";
import IORedis from "ioredis";

import { env } from "@/lib/env.server";

export type LogListener = (entry: LogEntry) => void;

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
      const entry = decodeLogEntry(raw);
      if (!entry) {
        return;
      }
      for (const listener of this.listeners.get(channel) ?? []) {
        listener(entry);
      }
    });
  }

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
        this.subscriber.unsubscribe(channel).catch(() => {});
      }
    };
  }

  async backlog(deploymentId: string): Promise<LogEntry[]> {
    const raw = await redis.lrange(logBufferKey(deploymentId), 0, -1);
    const entries: LogEntry[] = [];
    for (const item of raw) {
      const entry = decodeLogEntry(item);
      if (entry) {
        entries.push(entry);
      }
    }
    return entries;
  }
}

export const logHub: LogHub =
  globalForRedis.__noddleLogHub ?? new LogHub(redis);
globalForRedis.__noddleLogHub = logHub;
