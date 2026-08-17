import { randomBytes } from "node:crypto";
import { request } from "node:https";

import { execArgv, writeRemoteFile } from "@noddle/ssh-executor";
import type { ExecOptions, SshClient } from "@noddle/ssh-executor";

/**
 * The registry's account. A constant and not a setting: the installer
 * writes this exact same name into the htpasswd, and a second account
 * wouldn't have anyone to distinguish it from — there's only one image
 * producer, the worker.
 */
export const REGISTRY_USER = "noddle";

export interface RegistryConfig {
  /**
   * PEM of the CA that signs the registry's certificate.
   *
   * `undefined` for an EXTERNAL registry: ghcr.io or the Hub present a
   * certificate signed by a public CA, which the daemon already knows. So
   * there's nothing to deposit on nodes, and `ensureRegistryTrust` reflects
   * that by doing nothing rather than writing an empty file.
   */
  caCert?: string;
  /** `host:port`, exactly as it appears in image tags. */
  host: string;
  /**
   * What goes between the host and the image name. Most external registries
   * require an owner there (`ghcr.io/<org>/…`); the embedded registry has
   * none.
   */
  imagePrefix?: string;
  password: string;
  /** `noddle` for the embedded registry, the provided identifier otherwise. */
  username: string;
}

/**
 * Deposits the registry's CA on a node.
 *
 * `/etc/docker/certs.d/<host:port>/ca.crt` is re-read by the daemon on EVERY
 * request to that registry — measured on a daemon that had been running for
 * three days: the push goes from "x509: certificate signed by unknown
 * authority" to succeeding without any Docker service restarting.
 *
 * This is what distinguishes this path from `insecure-registries` in
 * daemon.json, which would have required a daemon restart — hence, in Swarm
 * mode where `live-restore` doesn't exist, cutting off every task on the
 * node. Migrating a running installation therefore cuts off nothing.
 *
 * Returns `true` if the file was written, `false` if it was already
 * correct. Safe to replay: it's a provisioning step, it runs on every server
 * addition and on worker startup.
 */
export async function ensureRegistryTrust(
  client: SshClient,
  registry: RegistryConfig,
): Promise<boolean> {
  const { caCert } = registry;
  if (!caCert) {
    return false;
  }

  const dir = `/etc/docker/certs.d/${registry.host}`;
  const target = `${dir}/ca.crt`;

  const current = await execArgv(client, ["sudo", "cat", target]);
  if (current.code === 0 && current.stdout.trim() === caCert.trim()) {
    return false;
  }

  // Via SFTP then `sudo install`, not a heredoc: a PEM is inert, but making
  // it travel through a remote shell would reopen the injection class that
  // `writeRemoteFile` exists to close. The SSH user can't write under /etc,
  // hence going through /tmp.
  const staging = `/tmp/noddle-ca-${randomBytes(6).toString("hex")}.crt`;
  await writeRemoteFile(client, staging, caCert);
  try {
    // `install -D` creates the parent directories AND sets the mode in one
    // go. The directory name contains a ":" — hence execArgv, never a
    // concatenated string.
    const res = await execArgv(client, ["sudo", "install", "-D", "-m", "644", staging, target]);
    if (res.code !== 0) {
      throw new Error(
        `could not install the registry CA: ${res.stderr.trim() || res.stdout.trim()}`,
      );
    }
  } finally {
    await execArgv(client, ["rm", "-f", staging]);
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Push
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The credentials file `docker --config` reads, built here rather than
 * obtained through `docker login`.
 *
 * `docker login --password-stdin` would assume a pipe, hence a shell string
 * `printf '%s' '<secret>' | …` — and that string becomes the argv of the
 * shell SSH launches, readable in `ps` on the target machine for the
 * duration of the run. Writing the file directly skips the step: no process
 * ever sees the password.
 */
function dockerConfigJson(registry: RegistryConfig): string {
  const auth = Buffer.from(`${registry.username}:${registry.password}`).toString("base64");
  return JSON.stringify({ auths: { [registry.host]: { auth } } });
}

export interface PushOptions extends ExecOptions {
  /** Full tag, already qualified by the registry's host. */
  imageTag: string;
  /**
   * Removes the local copy after a successful push. This is what makes the
   * build node stop accumulating: the image now lives in the registry, and
   * Swarm will pull it from there — including on this very node.
   */
  removeLocal?: boolean;
}

/**
 * Pushes an already-built image, through the host's daemon.
 *
 * And NOT through `buildx --push`, which would otherwise be more direct:
 * buildx's push is performed by `buildkitd`, which runs inside the capped
 * builder's container and has its own root CA store. Our CA isn't there, and
 * putting it there is a separate problem, not measured. The host's daemon,
 * on the other hand, already has `/etc/docker/certs.d`.
 */
export async function pushImage(
  client: SshClient,
  registry: RegistryConfig,
  o: PushOptions,
): Promise<void> {
  if (!o.imageTag.startsWith(`${registry.host}/`)) {
    throw new Error(`image to push is not qualified by the registry: ${o.imageTag}`);
  }

  const dir = `/tmp/noddle-push-${randomBytes(6).toString("hex")}`;
  // Mode 700 is set on the DIRECTORY before writing: SFTP creates the file
  // with the session's umask, and it's the directory that protects it.
  const made = await execArgv(client, ["mkdir", "-p", "-m", "700", dir]);
  if (made.code !== 0) {
    throw new Error(`could not create credentials directory: ${made.stderr}`);
  }

  try {
    await writeRemoteFile(client, `${dir}/config.json`, dockerConfigJson(registry));
    const res = await execArgv(client, ["sudo", "docker", "--config", dir, "push", o.imageTag], {
      onStderr: o.onStderr,
      onStdout: o.onStdout,
    });
    if (res.code !== 0) {
      const tail = (res.stderr || res.stdout).trim().split("\n").slice(-6).join("\n");
      throw new Error(`push to the registry failed (code ${res.code})\n${tail}`);
    }
  } finally {
    // Always, even if the push threw: the credentials don't stay on the
    // target machine.
    await execArgv(client, ["rm", "-rf", dir]);
  }

  if (o.removeLocal) {
    // Doesn't matter if it fails: the image is in the registry, which is
    // the only fact that matters going forward. An `rmi` refused — because
    // a container still uses it — must not turn a successful deployment
    // into a failed one.
    await execArgv(client, ["sudo", "docker", "rmi", o.imageTag]);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Portability of an image reference
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A pushed image's tag: `<host:port>/<service>:<sha>-<timestamp>`.
 *
 * The prefix isn't decorative — it's what Docker reads to know where to
 * pull from, so it's what carries the fact "this image is portable".
 */
export function registryImageTag(registry: RegistryConfig, name: string, version: string): string {
  const prefix = registry.imagePrefix ? `${registry.imagePrefix}/` : "";
  return `${registry.host}/${prefix}${name}:${version}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Retention
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How many versions per service the registry keeps.
 *
 * It has to be said plainly: this TRIMS the "roll back to any previous
 * version" that sets Noddle apart from Swarm — it becomes "any of the last
 * ten". But the alternative isn't "all of them": without retention the
 * limit still exists, it's "until the disk is full", and that one is
 * announced nowhere and arrives without warning.
 *
 * Ten, because railpack's base layer is SHARED across all of a service's
 * versions: measured, a second image only costs its own application layer.
 * The cost of ten versions is therefore close to that of one.
 */
export const KEEP_PER_SERVICE = 10;

/**
 * A call to the registry's API, with ITS CA and only that one.
 *
 * `fetch` would force trusting the CA at the ENTIRE PROCESS level
 * (`NODE_EXTRA_CA_CERTS`), so also for S3 and for notifications, which have
 * nothing to do with it. `node:https` takes the trust chain per request: the
 * scope then matches what we meant to say.
 *
 * Incidentally, it makes failures readable. `fetch` fails with "fetch
 * failed" no matter what — the same opaque message already noted for
 * notifications; here the error carries the real TLS code.
 */
function registryRequest(
  registry: RegistryConfig,
  o: { headers?: Record<string, string>; method: string; path: string },
): Promise<{
  headers: Record<string, string | string[] | undefined>;
  status: number;
}> {
  const [hostname, port] = registry.host.split(":");
  return new Promise((resolve, reject) => {
    const req = request(
      {
        ca: registry.caCert,
        headers: {
          authorization: `Basic ${Buffer.from(`${REGISTRY_USER}:${registry.password}`).toString("base64")}`,
          ...o.headers,
        },
        hostname,
        method: o.method,
        path: o.path,
        port: port ?? "443",
      },
      (res) => {
        // The body is never useful to us — only the status and headers
        // carry the response — but it MUST be consumed, otherwise the
        // socket stays open and the process won't return control.
        res.resume();
        res.on("end", () => resolve({ headers: res.headers, status: res.statusCode ?? 0 }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** Splits `host:port/repository:tag` into its two useful halves. */
export function parseRegistryRef(
  image: string,
  registry: RegistryConfig,
): { repository: string; tag: string } | null {
  const prefix = `${registry.host}/`;
  if (!image.startsWith(prefix)) {
    return null;
  }
  const rest = image.slice(prefix.length);
  const colon = rest.lastIndexOf(":");
  if (colon <= 0) {
    return null;
  }
  return { repository: rest.slice(0, colon), tag: rest.slice(colon + 1) };
}

/**
 * Deletes a tag's manifest. Returns `true` if it's no longer there afterward.
 *
 * This reclaims NO bytes by itself — measured: the tag disappears from
 * `tags/list` and the volume doesn't move. The layers remain, referenced by
 * nothing. It's `garbageCollect` that reclaims them, and it can only collect
 * manifests already deleted. The two go together or serve no purpose: the
 * same trap as "delete the row without deleting the object" already paid
 * for on backups.
 */
export async function deleteManifest(
  registry: RegistryConfig,
  ref: { repository: string; tag: string },
): Promise<boolean> {
  // The digest is only readable if we ANNOUNCE the accepted manifest types:
  // without this header, the registry answers in a legacy format and
  // `Docker-Content-Digest` doesn't designate the manifest we want to erase.
  const accept = [
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.docker.distribution.manifest.v2+json",
  ].join(", ");

  const head = await registryRequest(registry, {
    headers: { accept },
    method: "HEAD",
    path: `/v2/${ref.repository}/manifests/${ref.tag}`,
  });
  const digest = head.headers["docker-content-digest"];
  if (!(head.status >= 200 && head.status < 300 && typeof digest === "string")) {
    return false;
  }
  const del = await registryRequest(registry, {
    method: "DELETE",
    path: `/v2/${ref.repository}/manifests/${digest}`,
  });
  // 202 = accepted, 404 = already gone. Both count as "it's no longer there".
  return del.status === 202 || del.status === 404;
}

/**
 * Reclaims the bytes of layers no manifest references anymore.
 *
 * Runs INSIDE the registry container, on the manager: it's work on the
 * registry's filesystem, not an API call.
 *
 * ⚠ never run this during a push. A layer currently being uploaded is
 * referenced by no manifest — hence collectable — and the push would
 * succeed while leaving an incomplete image behind. This is why retention
 * goes through the SAME queue as deployments, at concurrency 1.
 */
export async function garbageCollect(
  managerClient: SshClient,
  containerName: string,
): Promise<void> {
  const res = await execArgv(managerClient, [
    "sudo",
    "docker",
    "exec",
    containerName,
    "registry",
    "garbage-collect",
    "--delete-untagged",
    // registry 3 moved this path from v2's /etc/docker/registry.
    "/etc/distribution/config.yml",
  ]);
  if (res.code !== 0) {
    throw new Error(
      `garbage-collect failed (code ${res.code}): ${res.stderr.trim().split("\n").slice(-3).join(" ")}`,
    );
  }
}

/**
 * Is an image reachable from ANY node?
 *
 * This isn't a heuristic: it's exactly the fact that Docker itself reads
 * from the reference to decide where to pull from. A reference without a
 * registry host designates the node's LOCAL store, hence an image that
 * exists nowhere else.
 *
 * This function is what decides the placement constraint, deployment by
 * deployment — never a global setting. A rollback to an image from before
 * the registry thus stays pinned to the node that holds it, and keeps
 * working, while new deployments are free.
 */
export function isPortableImage(image: string, registry: RegistryConfig | undefined): boolean {
  return registry !== undefined && image.startsWith(`${registry.host}/`);
}
