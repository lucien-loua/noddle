import type { servers } from "@noddle/db/schema";
import { exec, openExecPty, quoteArg } from "@noddle/ssh-executor";
import type { SshClient } from "@noddle/ssh-executor";

import { sseChannel } from "@/lib/sse-channel.server";
import type { SseChannel } from "@/lib/sse-channel.server";
import { connectToServer } from "@/lib/ssh.server";

const DEFAULT_TAIL = 500;
const MAX_TAIL = 5000;

const RECONNECT_MS = 1500;

const SINCE_VALUES = new Set(["all", "1h", "6h", "24h", "168h", "720h"]);

export const RESOURCE_UUID = /^[0-9a-f-]{36}$/i;

const SWARM_SERVICE_LABEL = "com.docker.swarm.service.name";

const LATEST_FORMAT = "{{.ID}} {{.State}}";
const RUNNING = "running";
const SPACES = /\s+/;

const REATTACH_NOTICE =
  "… reattached to the container, some lines may be missing …\n";

type ServerRow = typeof servers.$inferSelect;

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
  return `docker ps -a -l --filter ${filter} --format ${quoteArg(LATEST_FORMAT)}`;
}

export function parseTail(raw: string | null): number {
  if (!raw) {
    return DEFAULT_TAIL;
  }
  const n = Math.trunc(Number(raw));
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

export function containerLogStream(
  request: Request,
  server: ServerRow,
  attach: (channel: SseChannel, client: SshClient) => () => void
): Response {
  return sseChannel(request, async (channel) => {
    channel.reset();

    let client: SshClient | undefined;
    try {
      client = await connectToServer(server);
      return attach(channel, client);
    } catch (error) {
      sendLogError(channel.send, error);
      client?.end();
      channel.finish();
    }
  });
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
  });
  pty.onClose(() => onClose());
}

export function followContainerById(
  channel: SseChannel,
  client: SshClient,
  containerId: string,
  tail: number,
  since: string
): () => void {
  const { finish } = channel;
  let session: Awaited<ReturnType<typeof openExecPty>> | undefined;
  let aborted = false;

  const done = () => {
    client.end();
    finish();
  };

  const leave = () => {
    aborted = true;
    session?.close();
    client.end();
  };

  const start = async () => {
    try {
      const pty = await openExecPty(
        client,
        followCommand(containerId, tail, since)
      );
      if (aborted || channel.closed) {
        pty.close();
        done();
        return;
      }
      session = pty;
      pipePty(channel, pty, done);
    } catch (error) {
      sendLogError(channel.send, error);
      done();
    }
  };

  if (channel.closed) {
    done();
    return leave;
  }

  start();
  return leave;
}

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
    client.end();
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

  const pump = async () => {
    if (aborted || channel.closed) {
      done();
      return;
    }

    try {
      const result = await exec(client, latestContainerCommand(swarmName));
      if (aborted || channel.closed) {
        done();
        return;
      }
      const [id, state] = result.stdout.trim().split(SPACES);
      if (!id) {
        schedule();
        return;
      }
      const resuming = id === followedId;
      if (resuming && state !== RUNNING) {
        schedule();
        return;
      }
      if (resuming) {
        channel.send({ data: REATTACH_NOTICE, type: "chunk" });
      }
      followedId = id;
      attach(
        await openExecPty(client, followCommand(id, resuming ? 0 : tail, since))
      );
    } catch {
      if (aborted || channel.closed) {
        done();
        return;
      }
      schedule();
    }
  };

  if (channel.closed) {
    done();
    return leave;
  }

  pump();
  return leave;
}
