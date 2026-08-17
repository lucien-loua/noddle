import { exec, openExecPty, quoteArg } from "@noddle/ssh-executor";
import type { SshClient } from "@noddle/ssh-executor";

import type { SseChannel } from "@/lib/sse-channel.server";

/** The catch-up window. Enough to see a full startup. */
const DEFAULT_TAIL = 500;
const MAX_TAIL = 5000;

/** Pause between follow attempts when the container is gone or replaced. */
const RECONNECT_MS = 1500;

const SINCE_VALUES = new Set(["all", "1h", "6h", "24h", "168h", "720h"]);

export const RESOURCE_UUID = /^[0-9a-f-]{36}$/i;

/** The label Swarm sets on each task's container. */
const SWARM_SERVICE_LABEL = "com.docker.swarm.service.name";

/**
 * Remote command — measured quirks (git history has the long form):
 *
 * 1. Container `docker logs`, not `docker service logs` (time order).
 * 2. `2>&1` — engines log on stderr; without it the tab is nearly empty.
 * 3. **PTY required for live lines.** The Docker CLI is Go: without a TTY
 *    its stdout is block-buffered. `stdbuf` is a no-op on Go. We allocate
 *    the PTY on the ssh2 channel (`openExecPty`).
 * 4. Follow ONE container id. When it dies (stop / restart), the loop
 *    below waits for a *different* id — re-following the same stopped
 *    container would dump the same tail in a tight loop.
 */
function followCommand(
  containerId: string,
  tail: number,
  since: string
): string {
  const sinceFlag = since === "all" ? "" : ` --since ${quoteArg(since)}`;
  return `exec docker logs --tail ${tail}${sinceFlag} --follow ${quoteArg(containerId)} 2>&1`;
}

function latestContainerCommand(swarmName: string): string {
  const filter = quoteArg(`label=${SWARM_SERVICE_LABEL}=${swarmName}`);
  return `docker ps -a -q -l --filter ${filter}`;
}

export function parseTail(raw: string | null): number {
  if (!raw) {
    return DEFAULT_TAIL;
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) {
    return DEFAULT_TAIL;
  }
  return Math.min(n, MAX_TAIL);
}

export function parseSince(raw: string | null): string {
  if (!(raw && SINCE_VALUES.has(raw))) {
    return "all";
  }
  return raw;
}

export function sendLogError(send: SseChannel["send"], error: unknown): void {
  send({
    data: `Could not read logs: ${error instanceof Error ? error.message : String(error)}\n`,
    type: "chunk",
  });
  send({ status: "error", type: "end" });
}

function pipePty(
  channel: SseChannel,
  pty: Awaited<ReturnType<typeof openExecPty>>,
  onClose: () => void
): void {
  pty.onData((chunk) => {
    channel.send({
      data: chunk.toString("utf-8").replaceAll("\r", ""),
      type: "chunk",
    });
    channel.flush();
  });
  pty.onClose(() => onClose());
}

/**
 * Arms a PTY follow and returns the cancel fn immediately. When the
 * followed container dies, wait for a new id instead of ending the SSE
 * — Start/Restart replace the task, and the tab should pick it up.
 */
export function followContainerLogs(
  channel: SseChannel,
  client: SshClient,
  swarmName: string,
  tail: number,
  since: string
): () => void {
  const { finish } = channel;
  let aborted = false;
  let followedId: string | null = null;
  let session: Awaited<ReturnType<typeof openExecPty>> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const leave = () => {
    aborted = true;
    if (timer) {
      clearTimeout(timer);
    }
    session?.close();
  };

  const done = () => {
    client.end();
    finish();
  };

  const schedule = () => {
    if (aborted || channel.closed) {
      done();
      return;
    }
    timer = setTimeout(pump, RECONNECT_MS);
  };

  const attach = (pty: Awaited<ReturnType<typeof openExecPty>>) => {
    if (aborted || channel.closed) {
      pty.close();
      done();
      return;
    }
    session = pty;
    pipePty(channel, pty, () => {
      session = undefined;
      if (aborted || channel.closed) {
        done();
        return;
      }
      schedule();
    });
  };

  const pump = () => {
    if (aborted || channel.closed) {
      done();
      return;
    }

    exec(client, latestContainerCommand(swarmName))
      .then((result) => {
        if (aborted || channel.closed) {
          done();
          return;
        }
        const id = result.stdout.trim();
        // Same id already followed to EOF (stopped container): wait for a
        // replacement rather than dumping the same tail forever.
        if (id.length === 0 || id === followedId) {
          schedule();
          return;
        }
        followedId = id;
        return openExecPty(client, followCommand(id, tail, since));
      })
      .then((pty) => {
        if (!pty) {
          return;
        }
        attach(pty);
      })
      .catch(() => {
        if (aborted || channel.closed) {
          done();
          return;
        }
        schedule();
      });
  };

  if (channel.closed) {
    done();
    return leave;
  }

  pump();
  return leave;
}
