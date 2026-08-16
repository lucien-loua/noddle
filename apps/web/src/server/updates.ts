import { execArgv } from '@noddle/ssh-executor';
import type { SshClient } from '@noddle/ssh-executor';
import { createServerFn } from "@tanstack/react-start";

import { runGuarded } from "@/lib/permission.server";
import { requireSession } from "@/lib/session.server";
import { withManagerSession } from "@/lib/ssh.server";

/**
 * Where the installer puts the sources. This is `NODDLE_DIR`'s default, and
 * it is not re-read from the machine: the path is the documented one, and
 * an installation that moved it updates itself with the same command it was
 * launched with by hand.
 */
const NODDLE_DIR = "/opt/noddle";

/** The tracked branch. `NODDLE_REF`'s default in `install.sh`. */
const NODDLE_REF = "main";

/**
 * The update log, on the HOST and not inside a container.
 *
 * It's the only place where the run survives: the process writing it is
 * detached, and the containers that could relay it are precisely the ones
 * restarting.
 */
const UPDATE_LOG = "/var/log/noddle-update.log";

/** The log's last lines, enough to see the current step. */
const LOG_LINES = 40;

/** "<sha>\trefs/heads/main" — we only keep the first field. */
const FIRST_FIELD = /\s+/;

export interface UpdateStatus {
  /**
   * `true` when we KNOW the remote is ahead: both versions are known and
   * differ.
   *
   * Distinct from `updatable` just below, and the nuance isn't theoretical
   * — it's the case for EVERY installation that predates `NODDLE_COMMIT`,
   * so for each one's very first update.
   */
  behind: boolean;
  /** The last update's run, or `null` if there has never been one. */
  log: string | null;
  /** What the remote repository has on the tracked branch, `null` if
   *  unreachable. */
  remoteCommit: string | null;
  /**
   * The commit THIS process's image was built from.
   *
   * `null` in development, where the web app runs from source: there's no
   * version to compare then, and the screen says so rather than making one
   * up.
   */
  runningCommit: string | null;
  /** Why the machine couldn't be reached, if applicable. */
  unreachable: string | null;
  /**
   * Is there anything to do? True as soon as the remote is known UNLESS we
   * know the two match.
   *
   * **"We don't know" grants, it doesn't forbid.** An installation built
   * before `NODDLE_COMMIT` existed reports no version at all: requiring
   * proof that it's behind would make its button inert by showing
   * "Up to date" — that is, the screen asserting something false, precisely
   * on the machine that most needs updating. And erring in this direction
   * costs nothing: `install.sh` is idempotent, an unnecessary update just
   * rebuilds.
   */
  updatable: boolean;
}

/**
 * The commit baked into the image at build time.
 *
 * This is what gets checked after clicking, and not the HEAD of the
 * repository on the host's disk: `install.sh` does its `git checkout` well
 * BEFORE rebuilding and restarting. The disk changes within seconds, which
 * would announce a finished update while the old version is still serving.
 * Only THIS process's variable proves the new code is running.
 */
function runningCommit(): string | null {
  return process.env.NODDLE_COMMIT || null;
}

/**
 * What the remote repository has on the tracked branch.
 *
 * `git ls-remote` and not the GitHub API: the update's transport is a
 * `git fetch` over HTTPS against a public repository, and `ls-remote`
 * queries exactly what `install.sh` will fetch. This also holds for an
 * installation whose `origin` is a local bundle — the case of the trial
 * VPS — where a hardcoded GitHub URL would answer about the wrong thing.
 */
async function readRemoteCommit(client: SshClient): Promise<string | null> {
  // `sudo`, like EVERYTHING that touches `/opt/noddle` — the installer
  // writes there as root. Without it, git refuses: "detected dubious
  // ownership in repository at /opt/noddle", since the SSH user doesn't own
  // it. Measured on a real installation; the error doesn't say
  // "permission", it says `origin` isn't a repository, which sends you
  // looking in the wrong place.
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
  // "<sha>\trefs/heads/main". No `| head` or `| grep`: these commands run
  // under `set -o pipefail` and a consumer that exits early would send a
  // SIGPIPE to the producer — the race already paid for in Phase 0.
  return res.stdout.trim().split(FIRST_FIELD)[0] ?? null;
}

export const getUpdateStatus = createServerFn({ method: "GET" }).handler(
  async (): Promise<UpdateStatus> => {
    // `requireSession` and not `requirePermission`: all four roles are
    // allowed to see the version. A guard would turn nobody away and would
    // write an audit line on every page view — the same hole through which
    // /audit buried its own signal.
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
    // Knowing the remote is enough, UNLESS we know the two match. An
    // installation from before `NODDLE_COMMIT` reports no version at all:
    // requiring proof that it's behind would leave "Up to date" on the
    // machine that most needs updating.
    status.updatable =
      Boolean(remote) && !(remote && running && remote === running);
    return status;
  }
);

export const startUpdate = createServerFn({ method: "POST" }).handler(
  async (): Promise<{ started: true }> =>
    // No `target`: the object is the installation itself, which has no row.
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
