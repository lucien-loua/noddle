import type { LogMessage } from "@noddle/shared/logs";

export const SSE_HEARTBEAT_MS = 25_000;

export const SSE_HEADERS = Object.freeze({
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "Content-Type": "text/event-stream",
  "X-Accel-Buffering": "no",
});

export interface SseChannel {
  get closed(): boolean;
  finish: () => void;
  reset: () => void;
  send: (message: LogMessage, id?: number) => void;
}

type SseCancel = () => void;
type SseSourceResult = SseCancel | undefined;

const SSE_OPEN_PAD = `: ${" ".repeat(4096)}\n\n`;

export function sseChannel(
  request: Request,
  source: (channel: SseChannel) => SseSourceResult | Promise<SseSourceResult>
): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let cancel: (() => void) | undefined;

      const heartbeat = setInterval(() => {
        write(": ping\n\n");
      }, SSE_HEARTBEAT_MS);

      const finish = () => {
        if (closed) {
          return;
        }
        closed = true;
        clearInterval(heartbeat);
        cancel?.();
        try {
          controller.close();
        } catch {}
      };

      const write = (frame: string) => {
        if (closed) {
          return;
        }
        try {
          controller.enqueue(encoder.encode(frame));
        } catch {
          finish();
        }
      };

      const send = (message: LogMessage, id?: number) => {
        const head = id === undefined ? "" : `id: ${id}\n`;
        write(
          `${head}event: ${message.type}\ndata: ${JSON.stringify(message)}\n\n`
        );
      };

      const channel: SseChannel = {
        get closed() {
          return closed;
        },
        finish,
        reset: () => write('event: reset\ndata: {"type":"reset"}\n\n'),
        send,
      };

      request.signal.addEventListener("abort", finish);
      write(SSE_OPEN_PAD);

      try {
        const maybeCancel = await source(channel);
        if (typeof maybeCancel === "function") {
          if (closed) {
            maybeCancel();
          } else {
            cancel = maybeCancel;
          }
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
