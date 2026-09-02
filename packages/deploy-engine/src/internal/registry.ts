import { randomBytes } from "node:crypto";
import { request } from "node:https";

import { execArgv, writeRemoteFile } from "@noddle/ssh-executor";
import type { ExecOptions, SshClient } from "@noddle/ssh-executor";

export const REGISTRY_USER = "noddle";

export interface RegistryConfig {
  caCert?: string;
  host: string;
  imagePrefix?: string;
  password: string;
  username: string;
}

export async function ensureRegistryTrust(
  client: SshClient,
  registry: RegistryConfig
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

  const staging = `/tmp/noddle-ca-${randomBytes(6).toString("hex")}.crt`;
  await writeRemoteFile(client, staging, caCert);
  try {
    const res = await execArgv(client, [
      "sudo",
      "install",
      "-D",
      "-m",
      "644",
      staging,
      target,
    ]);
    if (res.code !== 0) {
      throw new Error(
        `could not install the registry CA: ${res.stderr.trim() || res.stdout.trim()}`
      );
    }
  } finally {
    await execArgv(client, ["rm", "-f", staging]);
  }
  return true;
}

function dockerConfigJson(registry: RegistryConfig): string {
  const auth = Buffer.from(
    `${registry.username}:${registry.password}`
  ).toString("base64");
  return JSON.stringify({ auths: { [registry.host]: { auth } } });
}

export interface PushOptions extends ExecOptions {
  imageTag: string;
  removeLocal?: boolean;
}

export async function pushImage(
  client: SshClient,
  registry: RegistryConfig,
  o: PushOptions
): Promise<void> {
  if (!o.imageTag.startsWith(`${registry.host}/`)) {
    throw new Error(
      `image to push is not qualified by the registry: ${o.imageTag}`
    );
  }

  const dir = `/tmp/noddle-push-${randomBytes(6).toString("hex")}`;
  const made = await execArgv(client, ["mkdir", "-p", "-m", "700", dir]);
  if (made.code !== 0) {
    throw new Error(`could not create credentials directory: ${made.stderr}`);
  }

  try {
    await writeRemoteFile(
      client,
      `${dir}/config.json`,
      dockerConfigJson(registry)
    );
    const res = await execArgv(
      client,
      ["sudo", "docker", "--config", dir, "push", o.imageTag],
      {
        onStderr: o.onStderr,
        onStdout: o.onStdout,
      }
    );
    if (res.code !== 0) {
      const tail = (res.stderr || res.stdout)
        .trim()
        .split("\n")
        .slice(-6)
        .join("\n");
      throw new Error(
        `push to the registry failed (code ${res.code})\n${tail}`
      );
    }
  } finally {
    await execArgv(client, ["rm", "-rf", dir]);
  }

  if (o.removeLocal) {
    await execArgv(client, ["sudo", "docker", "rmi", o.imageTag]);
  }
}

export function registryImageTag(
  registry: RegistryConfig,
  name: string,
  version: string
): string {
  const prefix = registry.imagePrefix ? `${registry.imagePrefix}/` : "";
  return `${registry.host}/${prefix}${name}:${version}`;
}

export const KEEP_PER_SERVICE = 10;

function registryRequest(
  registry: RegistryConfig,
  o: { headers?: Record<string, string>; method: string; path: string }
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
        res.resume();
        res.on("end", () =>
          resolve({ headers: res.headers, status: res.statusCode ?? 0 })
        );
      }
    );
    req.on("error", reject);
    req.end();
  });
}

export function parseRegistryRef(
  image: string,
  registry: RegistryConfig
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

export async function deleteManifest(
  registry: RegistryConfig,
  ref: { repository: string; tag: string }
): Promise<boolean> {
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
  if (
    !(head.status >= 200 && head.status < 300 && typeof digest === "string")
  ) {
    return false;
  }
  const del = await registryRequest(registry, {
    method: "DELETE",
    path: `/v2/${ref.repository}/manifests/${digest}`,
  });
  return del.status === 202 || del.status === 404;
}

export async function garbageCollect(
  managerClient: SshClient,
  containerName: string
): Promise<void> {
  const res = await execArgv(managerClient, [
    "sudo",
    "docker",
    "exec",
    containerName,
    "registry",
    "garbage-collect",
    "--delete-untagged",
    "/etc/distribution/config.yml",
  ]);
  if (res.code !== 0) {
    throw new Error(
      `garbage-collect failed (code ${res.code}): ${res.stderr.trim().split("\n").slice(-3).join(" ")}`
    );
  }
}

export function isPortableImage(
  image: string,
  registry: RegistryConfig | undefined
): boolean {
  return registry !== undefined && image.startsWith(`${registry.host}/`);
}
