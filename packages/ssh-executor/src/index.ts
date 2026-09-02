import http from "node:http";
import type { Duplex } from "node:stream";

import Docker from "dockerode";
import { Client } from "ssh2";
import type { ClientChannel, ConnectConfig } from "ssh2";

export type SshClient = Client;

export type DockerApi = Docker;

export interface ServerCredentials {
  host: string;
  passphrase?: string;
  port?: number;
  privateKey: string;
  user: string;
}

export interface ExecResult {
  code: number | null;
  signal?: string;
  stderr: string;
  stdout: string;
}

export class SshError extends Error {
  readonly host: string;
  override readonly cause?: unknown;

  constructor(message: string, host: string, cause?: unknown) {
    super(message);
    this.name = "SshError";
    this.host = host;
    this.cause = cause;
  }
}

function connectConfig(creds: ServerCredentials): ConnectConfig {
  return {
    host: creds.host,
    keepaliveCountMax: 8,
    keepaliveInterval: 15_000,
    passphrase: creds.passphrase,
    port: creds.port ?? 22,
    privateKey: creds.privateKey,
    readyTimeout: 20_000,
    username: creds.user,
  };
}

export function connect(creds: ServerCredentials): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    const onError = (err: Error) => {
      client.removeAllListeners();
      reject(
        new SshError(`SSH connection failed: ${err.message}`, creds.host, err)
      );
    };
    client.once("ready", () => {
      client.removeListener("error", onError);
      resolve(client);
    });
    client.once("error", onError);
    client.connect(connectConfig(creds));
  });
}

export interface ExecOptions {
  onStderr?: (chunk: string) => void;
  onStdout?: (chunk: string) => void;
}

export function exec(
  client: Client,
  command: string,
  opts: ExecOptions = {}
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) {
        return reject(err);
      }

      let stdout = "";
      let stderr = "";
      let code: number | null = null;
      let signal: string | undefined;

      stream.on("data", (d: Buffer) => {
        const s = d.toString("utf-8");
        stdout += s;
        opts.onStdout?.(s);
      });
      stream.stderr.on("data", (d: Buffer) => {
        const s = d.toString("utf-8");
        stderr += s;
        opts.onStderr?.(s);
      });
      stream.on("exit", (c: number | null, sig?: string) => {
        code = c;
        signal = sig;
      });
      stream.on("close", () => resolve({ code, signal, stderr, stdout }));
    });
  });
}

const STREAM_STDERR_MAX = 64 * 1024;

export interface ExecStreamIo {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
}

export interface ExecStreamResult<T> {
  code: number | null;
  signal?: string;
  stderr: string;
  value: T;
}

export function execStream<T>(
  client: Client,
  command: string,
  consume: (io: ExecStreamIo) => Promise<T>
): Promise<ExecStreamResult<T>> {
  return new Promise((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) {
        reject(err);
        return;
      }

      let stderr = "";
      let code: number | null = null;
      let signal: string | undefined;

      stream.stderr.on("data", (d: Buffer) => {
        if (stderr.length < STREAM_STDERR_MAX) {
          stderr += d.toString("utf-8");
        }
      });
      stream.on("exit", (c: number | null, sig?: string) => {
        code = c;
        signal = sig;
      });

      const closed = new Promise<void>((res) => {
        stream.on("close", () => res());
      });

      consume({ stdin: stream, stdout: stream })
        .then(async (value) => {
          stream.resume();
          await closed;
          resolve({ code, signal, stderr, value });
        })
        .catch((error: unknown) => {
          stream.destroy();
          reject(error);
        });
    });
  });
}

export function quoteArg(arg: string): string {
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

export function execArgv(
  client: Client,
  argv: readonly string[],
  opts: ExecOptions = {}
): Promise<ExecResult> {
  if (argv.length === 0) {
    throw new TypeError("argv vide");
  }
  return exec(client, argv.map(quoteArg).join(" "), opts);
}

export function execStreamArgv<T>(
  client: Client,
  argv: readonly string[],
  consume: (io: ExecStreamIo) => Promise<T>
): Promise<ExecStreamResult<T>> {
  if (argv.length === 0) {
    throw new TypeError("argv vide");
  }
  return execStream(client, argv.map(quoteArg).join(" "), consume);
}

export function disconnect(client: Client): void {
  client.end();
}

export function writeRemoteFile(
  client: Client,
  path: string,
  content: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err) {
        reject(err);
        return;
      }
      sftp.writeFile(path, content, (writeErr) => {
        sftp.end();
        if (writeErr) {
          reject(writeErr);
          return;
        }
        resolve();
      });
    });
  });
}

export async function withServer<T>(
  creds: ServerCredentials,
  fn: (client: Client) => Promise<T>
): Promise<T> {
  const client = await connect(creds);
  try {
    return await fn(client);
  } finally {
    disconnect(client);
  }
}

class SshSocketAgent extends http.Agent {
  private readonly client: Client;
  private readonly socketPath: string;

  constructor(client: Client, socketPath: string) {
    super({ keepAlive: false, maxSockets: 8 });
    this.client = client;
    this.socketPath = socketPath;
  }

  override createConnection(
    _options: http.ClientRequestArgs,
    callback?: (err: Error | null, stream: Duplex) => void
  ): undefined {
    this.client.openssh_forwardOutStreamLocal(
      this.socketPath,
      (err, stream) => {
        if (err) {
          callback?.(err, null as unknown as Duplex);
          return;
        }
        const sock = stream as unknown as Record<string, unknown>;
        for (const m of [
          "setKeepAlive",
          "setNoDelay",
          "setTimeout",
          "ref",
          "unref",
        ]) {
          if (typeof sock[m] !== "function") {
            sock[m] = () => stream;
          }
        }
        callback?.(null, stream as unknown as Duplex);
      }
    );
  }
}

export interface DockerClientOptions {
  socketPath?: string;
}

export function dockerClient(
  client: Client,
  opts: DockerClientOptions = {}
): Docker {
  const socketPath = opts.socketPath ?? "/var/run/docker.sock";
  return new Docker({
    agent: new SshSocketAgent(client, socketPath),
    host: "docker",
    port: 80,
    protocol: "http",
  } as Docker.DockerOptions);
}

export interface PtyOptions {
  cols?: number;
  rows?: number;
  term?: string;
}

export interface PtySession {
  close: () => void;
  onClose: (cb: (code: number | null) => void) => void;
  onData: (cb: (data: Buffer) => void) => void;
  resize: (cols: number, rows: number) => void;
  write: (data: string | Buffer) => void;
}

function wrapChannel(
  stream: ClientChannel,
  client: Client,
  ownClient: boolean
): PtySession {
  let exitCode: number | null = null;
  stream.on("exit", (code: number | null) => {
    exitCode = code;
  });

  return {
    close: () => {
      stream.close();
      if (ownClient) {
        client.end();
      }
    },
    onClose: (cb) => {
      stream.on("close", () => {
        if (ownClient) {
          client.end();
        }
        cb(exitCode);
      });
    },
    onData: (cb) => {
      stream.on("data", (d: Buffer) => cb(d));
      stream.stderr.on("data", (d: Buffer) => cb(d));
    },
    resize: (cols, rows) => {
      stream.setWindow(rows, cols, 0, 0);
    },
    write: (data) => {
      stream.write(data);
    },
  };
}

function ptyDims(opts: PtyOptions): {
  cols: number;
  rows: number;
  term: string;
} {
  return {
    cols: opts.cols && opts.cols > 0 ? opts.cols : 80,
    rows: opts.rows && opts.rows > 0 ? opts.rows : 24,
    term: opts.term && opts.term.length > 0 ? opts.term : "xterm-256color",
  };
}

export function openShell(
  client: Client,
  opts: PtyOptions = {}
): Promise<PtySession> {
  const dims = ptyDims(opts);
  return new Promise((resolve, reject) => {
    client.shell(
      {
        cols: dims.cols,
        rows: dims.rows,
        term: dims.term,
      },
      (err, stream) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(wrapChannel(stream, client, false));
      }
    );
  });
}

export function openExecPty(
  client: Client,
  command: string,
  opts: PtyOptions = {}
): Promise<PtySession> {
  const dims = ptyDims(opts);
  return new Promise((resolve, reject) => {
    client.exec(
      command,
      {
        pty: {
          cols: dims.cols,
          rows: dims.rows,
          term: dims.term,
        },
      },
      (err, stream) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(wrapChannel(stream, client, false));
      }
    );
  });
}
