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

const UNAUTHENTICATED_SIGNATURES = [
  "could not read Username",
  "could not read Password",
  "terminal prompts disabled",
  "Authentication failed",
  "Permission denied (publickey)",
  "Repository not found",
  "access rights",
];

export function looksUnauthenticated(output: string): boolean {
  return UNAUTHENTICATED_SIGNATURES.some((sign) => output.includes(sign));
}

const URL_USERINFO = /^https:\/\/[^/@]+@/;

export function cloneAuthHint(o: {
  deployKey?: string | null;
  repoUrl: string;
}): string {
  if (o.repoUrl.startsWith("https://")) {
    if (URL_USERINFO.test(o.repoUrl)) {
      return "The token sent with this URL was refused. Reconnect the git provider, or check the installation still covers this repository.";
    }
    return "Nothing was sent to authenticate: this is an anonymous https clone. Connect a git provider and pick the repository from it, or switch the URL to SSH (git@host:org/repo.git) and select a deploy key. A deploy key is only ever used over SSH, never over https. If the repository is meant to be public, check the URL instead: a private repository and a mistyped one fail exactly the same way.";
  }
  if (o.deployKey) {
    return "The deploy key was refused. Add its public half to the repository, and check it grants read access to this branch.";
  }
  return "No deploy key was sent for an SSH URL. Select one in the service source settings.";
}

export function gitEnvPrefix(sshCommand: string | null): string {
  const env = ["GIT_TERMINAL_PROMPT=0"];
  if (sshCommand) {
    env.push(`GIT_SSH_COMMAND=${quoteArg(sshCommand)}`);
  }
  return `${env.join(" ")} `;
}

function check(stage: string, res: ExecResult): ExecResult {
  if (res.code !== 0) {
    const tail = (res.stderr || res.stdout)
      .trim()
      .split("\n")
      .slice(-8)
      .join("\n");
    const output = `${res.stderr}\n${res.stdout}`;
    const headline = looksOutOfMemory(output)
      ? `${stage} ran out of memory. The builder is capped so one heavy build cannot take down what is already running. Build on a larger server, or make the build lighter.`
      : `${stage} failed (code ${res.code})`;
    throw new BuildError(stage, `${headline}\n${tail}`, res.code);
  }
  return res;
}

export interface BuildCap {
  cpuPeriod: number;
  cpuQuota: number;
  memory: string;
}

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

const REMOTE_DRIVER = /^Driver:\s+remote$/m;

export const BUILDX_BUILDER = "noddle-builder";

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
const SAFE_REPO_URL = /^(https:\/\/|ssh:\/\/|file:\/\/|git@[\w.-]+:)/;

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

export interface CloneOptions extends ExecOptions {
  branch: string;
  commitSha?: string;
  deployKey?: string | null;
  dir: string;
  keyScope?: string;
  repoUrl: string;
  submodules?: boolean;
}

function keyDirFor(scope: string): string {
  return `/var/lib/noddle/keys/${scope}`;
}

async function installDeployKey(
  client: SshClient,
  scope: string,
  deployKey: string
): Promise<string> {
  const dir = keyDirFor(scope);
  const keyPath = `${dir}/id`;

  check(
    "deploy key directory",
    await exec(client, `sudo install -d -m 700 -o "$USER" ${quoteArg(dir)}`)
  );
  await writeRemoteFile(client, keyPath, ensureTrailingNewline(deployKey));
  check(
    "deploy key mode",
    await exec(client, `chmod 600 ${quoteArg(keyPath)}`)
  );

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
  return exec(client, `rm -rf ${quoteArg(keyDirFor(scope))}`).catch(() => null);
}

function ensureTrailingNewline(key: string): string {
  return key.endsWith("\n") ? key : `${key}\n`;
}

type GitRunner = (
  label: string,
  argv: readonly string[]
) => Promise<{ stdout: string }>;

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
  await git("git checkout", ["git", "-C", o.dir, "checkout", "--detach", sha]);
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

function withAuthHint(error: unknown, o: CloneOptions): unknown {
  if (!(error instanceof BuildError) || !looksUnauthenticated(error.message)) {
    return error;
  }
  return new BuildError(
    error.stage,
    `${error.message}\n\n${cloneAuthHint(o)}`,
    error.exitCode
  );
}

export async function fetchSource(
  client: SshClient,
  o: CloneOptions
): Promise<string> {
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

  const git = async (label: string, argv: readonly string[]) => {
    const command = `${gitEnvPrefix(sshCommand)}${argv.map(quoteArg).join(" ")}`;
    try {
      return check(label, await exec(client, command, o));
    } catch (error) {
      throw withAuthHint(error, o);
    }
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

export const FORCED_DEPLOY_PACKAGES = "... curl";

export interface BuildOptions extends ExecOptions {
  dir: string;
  imageTag: string;
  noCache?: boolean;
  publishDirectory?: string | null;
}

export async function buildImage(
  client: SshClient,
  o: BuildOptions
): Promise<void> {
  assertNotFlag(o.dir, "build directory");
  assertNotFlag(o.imageTag, "image tag");

  const publishDirectory = o.publishDirectory?.trim();

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
  contextDir: string;
  dockerfilePath: string;
  imageTag: string;
  noCache?: boolean;
}

export async function buildImageFromDockerfile(
  client: SshClient,
  o: DockerfileBuildOptions
): Promise<void> {
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
