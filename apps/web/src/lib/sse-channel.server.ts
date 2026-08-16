/**
 * Shared SSE response machinery: heartbeat, abort, close-once, LogMessage
 * framing, and the headers proxies need. Sources differ (Redis vs docker
 * logs); teardown must not.
 */
import type { LogMessage } from "@noddle/shared/logs";

/** Proxies cut an idle connection. Builds and quiet databases stay silent. */
export const SSE_HEARTBEAT_MS = 25_000;

export const SSE_HEADERS = Object.freeze({
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "Content-Type": "text/event-stream",
  // Without this, an nginx in front buffers the stream and live
  // output arrives in multi-kilobyte chunks.
  "X-Accel-Buffering": "no",
});

export interface SseChannel {
  /** True once finish() has run (abort, end, or error). */
  get closed(): boolean;
  finish: () => void;
  /**
   * Nudge proxies that buffer small writes (Bun→Vite in dev). An SSE
   * comment is ignored by EventSource; the padding is only on the wire.
   */
  flush: () => void;
  send: (message: LogMessage) => void;
}

/**
 * Open an SSE ReadableStream. `source` receives send/finish and may return
 * a cancel function that runs on finish (unsubscribe, kill remote, …).
 */
type SseCancel = () => void;
type SseSourceResult = SseCancel | undefined;

/** Enough to push past common 4 KiB proxy buffers without a full page of junk. */
const SSE_FLUSH_PAD = `: ${" ".repeat(4096)}\n\n`;

export function sseChannel(
  request: Request,
  source: (channel: SseChannel) => SseSourceResult | Promise<SseSourceResult>
): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let cancel: (() => void) | undefined;

      const finish = () => {
        if (closed) {
          return;
        }
        closed = true;
        if (heartbeat) {
          clearInterval(heartbeat);
        }
        cancel?.();
        try {
          controller.close();
        } catch {
          // already closed by the client
        }
      };

      const send = (message: LogMessage) => {
        if (closed) {
          return;
        }
        try {
          controller.enqueue(
            encoder.encode(
              `event: ${message.type}\ndata: ${JSON.stringify(message)}\n\n`
            )
          );
        } catch {
          finish();
        }
      };

      const flush = () => {
        if (closed) {
          return;
        }
        try {
          controller.enqueue(encoder.encode(SSE_FLUSH_PAD));
        } catch {
          finish();
        }
      };

      const channel: SseChannel = {
        get closed() {
          return closed;
        },
        finish,
        flush,
        send,
      };

      request.signal.addEventListener("abort", finish);

      heartbeat = setInterval(() => {
        if (closed) {
          return;
        }
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          finish();
        }
      }, SSE_HEARTBEAT_MS);

      try {
        const maybeCancel = await source(channel);
        if (typeof maybeCancel === "function") {
          cancel = maybeCancel;
        }
      } catch (error) {
        if (!closed) {
          send({
            data: `stream error: ${error instanceof Error ? error.message : String(error)}\n`,
            type: "chunk",
          });
          send({ status: "error", type: "end" });
          finish();
        }
      }
    },
  });

  return new Response(stream, { headers: { ...SSE_HEADERS } });
}
