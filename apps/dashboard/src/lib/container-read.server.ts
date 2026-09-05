import { isNoddleOwnedContainer } from "@noddle/shared/noddle-containers";
import { execArgv } from "@noddle/ssh-executor";
import type { SshClient } from "@noddle/ssh-executor";

const CONTROL_PLANE_PROJECT = "noddle";

export const CONTAINER_ID = /^[a-f0-9]{12,64}$/i;

export const PS_FORMAT = [
  "{{.ID}}",
  "{{.Names}}",
  "{{.Image}}",
  "{{.State}}",
  "{{.Status}}",
  "{{.Ports}}",
  '{{.Label "com.docker.swarm.service.name"}}',
  '{{.Label "com.docker.compose.project"}}',
].join("\\t");

export const PS_FIELDS = 8;

export type ContainerKind = "swarm" | "control-plane" | "unmanaged";

export interface ContainerRow {
  createdAt: string;
  id: string;
  image: string;
  kind: ContainerKind;
  name: string;
  ports: string;
  serverId: string;
  serverName: string;
  serviceName: string | null;
  state: string;
  status: string;
}

export interface ContainerMount {
  destination: string;
  mode: string;
  readWrite: boolean;
  source: string;
  type: string;
}

export interface ContainerNetwork {
  aliases: string[];
  gateway: string;
  ipAddress: string;
  macAddress: string;
  name: string;
}

export interface ContainerPort {
  containerPort: string;
  published: string | null;
}

export interface ContainerDetail {
  command: string;
  createdAt: string;
  envNames: string[];
  health: string | null;
  id: string;
  image: string;
  kind: ContainerKind;
  mounts: ContainerMount[];
  name: string;
  networks: ContainerNetwork[];
  ports: ContainerPort[];
  restartPolicy: string;
  state: string;
}

export function classify(o: {
  composeProject: string;
  name: string;
  swarmService: string;
}): ContainerKind {
  if (o.swarmService) {
    return "swarm";
  }
  if (o.composeProject === CONTROL_PLANE_PROJECT) {
    return "control-plane";
  }
  if (isNoddleOwnedContainer(o.name)) {
    return "control-plane";
  }
  return "unmanaged";
}

export function parsePs(
  stdout: string,
  server: { id: string; name: string }
): ContainerRow[] {
  const rows: ContainerRow[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    const parts = line.split("\t");
    if (parts.length !== PS_FIELDS) {
      continue;
    }
    const [
      id,
      name,
      image,
      state,
      status,
      ports,
      swarmService,
      composeProject,
    ] = parts as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    rows.push({
      createdAt: "",
      id,
      image,
      kind: classify({ composeProject, name, swarmService }),
      name,
      ports,
      serverId: server.id,
      serverName: server.name,
      serviceName: swarmService || null,
      state,
      status,
    });
  }
  return rows;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

const LEADING_SLASH = /^\//;

function parseMounts(value: unknown): ContainerMount[] {
  return list(value).map((entry) => {
    const mount = record(entry);
    return {
      destination: text(mount.Destination),
      mode: text(mount.Mode),
      readWrite: mount.RW !== false,
      source: text(mount.Name) || text(mount.Source),
      type: text(mount.Type),
    };
  });
}

function parseNetworks(value: unknown): ContainerNetwork[] {
  return Object.entries(record(value)).map(([name, raw]) => {
    const net = record(raw);
    const address = text(net.IPAddress);
    const prefix =
      typeof net.IPPrefixLen === "number" ? `/${net.IPPrefixLen}` : "";
    return {
      aliases: list(net.Aliases).flatMap((entry) => {
        const alias = text(entry);
        return alias ? [alias] : [];
      }),
      gateway: text(net.Gateway),
      ipAddress: address ? `${address}${prefix}` : "",
      macAddress: text(net.MacAddress),
      name,
    };
  });
}

function parsePorts(value: unknown): ContainerPort[] {
  const ports: ContainerPort[] = [];
  for (const [containerPort, raw] of Object.entries(record(value))) {
    const bindings = list(raw);
    if (bindings.length === 0) {
      ports.push({ containerPort, published: null });
      continue;
    }
    for (const entry of bindings) {
      const binding = record(entry);
      const host = text(binding.HostIp) || "0.0.0.0";
      ports.push({
        containerPort,
        published: `${host}:${text(binding.HostPort)}`,
      });
    }
  }
  return ports;
}

function parseEnvNames(value: unknown): string[] {
  const names = list(value).flatMap((entry) => {
    const name = text(entry).split("=")[0] ?? "";
    return name ? [name] : [];
  });
  return names.toSorted((a, b) => (a < b ? -1 : 1));
}

function parseCommand(root: Record<string, unknown>): string {
  const path = text(root.Path);
  const args = list(root.Args).flatMap((arg) => {
    const value = text(arg);
    return value ? [value] : [];
  });
  return [path, ...args].join(" ").trim();
}

export function parseInspect(stdout: string): ContainerDetail {
  const parsed: unknown = JSON.parse(stdout);
  const root = record(Array.isArray(parsed) ? parsed[0] : parsed);
  const id = text(root.Id);
  if (!id) {
    throw new Error("docker inspect returned no container");
  }

  const config = record(root.Config);
  const labels = record(config.Labels);
  const name = text(root.Name).replace(LEADING_SLASH, "");
  const networkSettings = record(root.NetworkSettings);
  const state = record(root.State);
  const policy = text(record(record(root.HostConfig).RestartPolicy).Name);

  return {
    command: parseCommand(root),
    createdAt: text(root.Created),
    envNames: parseEnvNames(config.Env),
    health: text(record(state.Health).Status) || null,
    id,
    image: text(config.Image) || text(root.Image),
    kind: classify({
      composeProject: text(labels["com.docker.compose.project"]),
      name,
      swarmService: text(labels["com.docker.swarm.service.name"]),
    }),
    mounts: parseMounts(root.Mounts),
    name,
    networks: parseNetworks(networkSettings.Networks),
    ports: parsePorts(networkSettings.Ports),
    restartPolicy: policy || "no",
    state: text(state.Status),
  };
}

export async function readKind(
  client: SshClient,
  containerId: string
): Promise<{ kind: ContainerKind; name: string } | null> {
  const res = await execArgv(client, [
    "sudo",
    "docker",
    "ps",
    "-a",
    "--no-trunc",
    "--filter",
    `id=${containerId}`,
    "--format",
    PS_FORMAT,
  ]);
  if (res.code !== 0) {
    return null;
  }
  const [row] = parsePs(res.stdout, { id: "", name: "" });
  return row ? { kind: row.kind, name: row.name } : null;
}
