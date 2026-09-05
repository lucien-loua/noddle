import { execArgv } from "@noddle/ssh-executor";
import type { SshClient } from "@noddle/ssh-executor";
import { createServerFn } from "@tanstack/react-start";

import { runGuarded } from "@/lib/permission.server";
import { requireSession } from "@/lib/session.server";
import { withSelfSession } from "@/lib/ssh.server";

const NODDLE_DIR = "/opt/noddle";

const UNTAGGED_REF = "main";

const UPDATE_LOG = "/var/log/noddle-update.log";

const LOG_LINES = 40;

const FIRST_FIELD = /\s+/;
const TAG_LINE = /^([0-9a-f]{40})\s+refs\/tags\/(v\d+\.\d+\.\d+)(\^\{\})?$/;

export interface UpdateStatus {
  behind: boolean;
  log: string | null;
  remoteCommit: string | null;
  remoteVersion: string | null;
  runningCommit: string | null;
  runningVersion: string | null;
  unreachable: string | null;
  updatable: boolean;
}

interface Release {
  commit: string;
  version: string | null;
}

function runningCommit(): string | null {
  return process.env.NODDLE_COMMIT || null;
}

function runningVersion(): string | null {
  return process.env.NODDLE_VERSION || null;
}

function versionParts(tag: string): number[] {
  return tag.slice(1).split(".").map(Number);
}

function compareVersions(a: string, b: string): number {
  const left = versionParts(a);
  const right = versionParts(b);
  for (const [index, value] of left.entries()) {
    const delta = value - (right[index] ?? 0);
    if (delta !== 0) {
      return delta;
    }
  }
  return 0;
}

function latestTag(stdout: string): Release | null {
  const commitOf = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const match = TAG_LINE.exec(line.trim());
    if (!(match?.[1] && match[2])) {
      continue;
    }
    const peeled = Boolean(match[3]);
    if (peeled || !commitOf.has(match[2])) {
      commitOf.set(match[2], match[1]);
    }
  }
  const version = [...commitOf.keys()].toSorted(compareVersions).at(-1);
  const commit = version ? commitOf.get(version) : undefined;
  return version && commit ? { commit, version } : null;
}

async function readRemoteRelease(client: SshClient): Promise<Release | null> {
  const tagged = await execArgv(client, [
    "sudo",
    "git",
    "-C",
    NODDLE_DIR,
    "ls-remote",
    "--tags",
    "origin",
    "v*",
  ]);
  if (tagged.code === 0) {
    const release = latestTag(tagged.stdout);
    if (release) {
      return release;
    }
  }

  const head = await execArgv(client, [
    "sudo",
    "git",
    "-C",
    NODDLE_DIR,
    "ls-remote",
    "origin",
    UNTAGGED_REF,
  ]);
  if (head.code !== 0) {
    return null;
  }
  const [commit] = head.stdout.trim().split(FIRST_FIELD);
  return commit ? { commit, version: null } : null;
}

export const getUpdateStatus = createServerFn({ method: "GET" }).handler(
  async (): Promise<UpdateStatus> => {
    await requireSession();

    const running = runningCommit();
    const status: UpdateStatus = {
      behind: false,
      log: null,
      remoteCommit: null,
      remoteVersion: null,
      runningCommit: running,
      runningVersion: runningVersion(),
      unreachable: null,
      updatable: false,
    };

    let unreachable: string | null = null;

    try {
      await withSelfSession(async (client) => {
        const release = await readRemoteRelease(client);
        status.remoteCommit = release?.commit ?? null;
        status.remoteVersion = release?.version ?? null;
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
        withSelfSession(async (client) => {
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
