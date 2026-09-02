import { execArgv } from "@noddle/ssh-executor";
import type { SshClient } from "@noddle/ssh-executor";
import { createServerFn } from "@tanstack/react-start";

import { runGuarded } from "@/lib/permission.server";
import { requireSession } from "@/lib/session.server";
import { withManagerSession } from "@/lib/ssh.server";

const NODDLE_DIR = "/opt/noddle";

const NODDLE_REF = "main";

const UPDATE_LOG = "/var/log/noddle-update.log";

const LOG_LINES = 40;

const FIRST_FIELD = /\s+/;

export interface UpdateStatus {
  behind: boolean;
  log: string | null;
  remoteCommit: string | null;
  runningCommit: string | null;
  unreachable: string | null;
  updatable: boolean;
}

function runningCommit(): string | null {
  return process.env.NODDLE_COMMIT || null;
}

async function readRemoteCommit(client: SshClient): Promise<string | null> {
  const res = await execArgv(client, [
    "sudo",
    "git",
    "-C",
    NODDLE_DIR,
    "ls-remote",
    "origin",
    NODDLE_REF,
  ]);
  if (res.code !== 0) {
    return null;
  }
  return res.stdout.trim().split(FIRST_FIELD)[0] ?? null;
}

export const getUpdateStatus = createServerFn({ method: "GET" }).handler(
  async (): Promise<UpdateStatus> => {
    await requireSession();

    const running = runningCommit();
    const status: UpdateStatus = {
      behind: false,
      log: null,
      remoteCommit: null,
      runningCommit: running,
      unreachable: null,
      updatable: false,
    };

    let unreachable: string | null = null;

    try {
      await withManagerSession(async (client) => {
        status.remoteCommit = await readRemoteCommit(client);
        const log = await execArgv(client, [
          "sudo",
          "tail",
          "-n",
          String(LOG_LINES),
          UPDATE_LOG,
        ]);
        status.log = log.code === 0 ? log.stdout.trimEnd() || null : null;
      });
    } catch (error) {
      unreachable = error instanceof Error ? error.message : String(error);
    }

    status.unreachable = unreachable;

    const remote = status.remoteCommit;
    status.behind = Boolean(remote && running && remote !== running);
    status.updatable =
      Boolean(remote) && !(remote && running && remote === running);
    return status;
  }
);

export const startUpdate = createServerFn({ method: "POST" }).handler(
  async (): Promise<{ started: true }> =>
    runGuarded({
      permission: { action: "update", resource: "installation" },
      run: async () =>
        withManagerSession(async (client) => {
          const res = await execArgv(client, [
            "sudo",
            "sh",
            "-c",
            `setsid nohup bash ${NODDLE_DIR}/installer/install.sh > ${UPDATE_LOG} 2>&1 < /dev/null &`,
          ]);
          if (res.code !== 0) {
            throw new Error(
              `could not start the update: ${res.stderr.trim() || res.stdout.trim()}`
            );
          }
          return { started: true as const };
        }),
    })
);
