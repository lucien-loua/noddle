import { createWriteStream } from "node:fs";
import type { WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";

import { redactUrlCredentials } from "@noddle/shared/redact";

export interface LogSink {
  close: () => Promise<{ storageUrl: string; byteSize: number }>;
  write: (chunk: string) => void;
}

export interface LogSinkOptions {
  deploymentId: string;
  onChunk?: (chunk: string) => void;
  root: string;
}

export async function createLogSink(o: LogSinkOptions): Promise<LogSink> {
  const path = resolvePath(o.root, `${o.deploymentId}.log`);
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
    write(raw: string) {
      if (closed) {
        return;
      }
      const chunk = redactUrlCredentials(raw);
      bytes += Buffer.byteLength(chunk, "utf-8");
      stream.write(chunk);
      try {
        o.onChunk?.(chunk);
      } catch {}
    },
  };
}
