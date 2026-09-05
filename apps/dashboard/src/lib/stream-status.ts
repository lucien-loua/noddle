import type { Tone } from "@/lib/format";

export type StreamStatus = "idle" | "live" | "lost" | "reconnecting";

export const MAX_RECONNECTS = 20;

export const STREAM_LABEL: Record<StreamStatus, string> = {
  idle: "finished",
  live: "live",
  lost: "connection lost",
  reconnecting: "reconnecting…",
};

export const STREAM_TONE: Record<StreamStatus, Tone> = {
  idle: "neutral",
  live: "ok",
  lost: "danger",
  reconnecting: "busy",
};
