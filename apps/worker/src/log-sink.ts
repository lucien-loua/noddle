import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface LogSink {
  /** Returns what's needed to fill `deployment_logs`. */
  close: () => Promise<{ storageUrl: string; byteSize: number }>;
  write: (chunk: string) => void;
}

export interface LogSinkOptions {
  deploymentId: string;
  /** Feeds the SSE stream. Must remain non-blocking. */
  onChunk?: (chunk: string) => void;
  /** Storage root. `/var/lib/noddle/logs` in production. */
  root: string;
}

export async function createLogSink(o: LogSinkOptions): Promise<LogSink> {
  const path = join(o.root, `${o.deploymentId}.log`);
  await mkdir(dirname(path), { recursive: true });

  const stream: WriteStream = createWriteStream(path, { flags: "a" });
  let bytes = 0;
  let closed = false;

  return {
    close() {
      closed = true;
      return new Promise((resolve, reject) => {
        stream.end((err?: Error | null) =>
          err
            ? reject(err)
            : resolve({ byteSize: bytes, storageUrl: `file://${path}` })
        );
      });
    },
    write(chunk: string) {
      if (closed) {
        return;
      }
      bytes += Buffer.byteLength(chunk, "utf8");
      stream.write(chunk);
      // The dashboard must never bring down a deployment. If the SSE stream
      // is dead, the build continues.
      try {
        o.onChunk?.(chunk);
      } catch {
        // intentionally ignored
      }
    },
  };
}
