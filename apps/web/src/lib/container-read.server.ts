/**
 * Reading a container on a machine: what it IS, and what it is made of.
 *
 * Extracted from `server/containers.ts` so the same knowledge is reachable
 * from a place a TanStack server function cannot go. The terminal
 * WebSocket lives in `server.ts` (Bun), and pulling `createServerFn` into
 * that graph is exactly what the `NodeResponse` note there warns about:
 * one import decides which `Response` class the process ends up with.
 *
 * So the kind of a container — the rule that forbids shelling into or
 * removing Noddle itself — is defined once, here, and imported by the
 * server functions, the log stream and the terminal alike.
 */
import { isNoddleOwnedContainer } from "@noddle/shared/noddle-containers";
import { execArgv } from "@noddle/ssh-executor";
import type { SshClient } from "@noddle/ssh-executor";

/** The Compose project of the control plane's stack. */
const CONTROL_PLANE_PROJECT = "noddle";

/** A container id as Docker writes it — short (12) or full (64). */
export const CONTAINER_ID = /^[a-f0-9]{12,64}$/i;

/**
 * The fields requested from `docker ps`, separated by TABS.
 *
 * Not `{{json .}}`: it flattens labels into a single "k=v,k=v" string, and a
 * VALUE can contain a comma — measured, `com.docker.compose.depends_on`
 * contains one. Splitting on it would corrupt the read. So we explicitly
 * request only the two labels that decide the kind, which removes the
 * problem instead of working around it.
 *
 * A tab can't appear in a container name, an image reference, the port
 * list, or the `Status` Docker formats.
 */
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

/** Kept next to the format string: the parser rejects any line that does
 *  not carry exactly this many fields, so the two move together. */
export const PS_FIELDS = 8;

/**
 * What you're allowed to do to a container, and it depends on what it IS.
 *
 * - `swarm`: a task. Stopping it means nothing, Swarm puts it back. The
 *   only honest action is restarting the SERVICE.
 * - `control-plane`: Noddle itself. Labeled as such, no destructive
 *   action — the button would destroy the screen carrying it.
 * - `unmanaged`: a container nobody is watching over. Only there do
 *   Stop/Restart/Remove make sense.
 */
export type ContainerKind = "swarm" | "control-plane" | "unmanaged";

export interface ContainerRow {
  createdAt: string;
  id: string;
  image: string;
  kind: ContainerKind;
  name: string;
  /** Docker's own port summary — "0.0.0.0:5432->5432/tcp", or empty. */
  ports: string;
  serverId: string;
  serverName: string;
  /** The Swarm service's name, when this is a task. It's THIS that a
   *  restart targets, not the container. */
  serviceName: string | null;
  /** `running`, `exited`, `created`… — machine-readable. */
  state: string;
  /** "Up 27 hours (healthy)" — Docker's own formatting, shown as-is and
   *  never parsed as a number. */
  status: string;
}

export interface ContainerMount {
  destination: string;
  /** "z", "ro"… — Docker's own string, empty when it set none. */
  mode: string;
  readWrite: boolean;
  /** The volume's NAME when it has one, the host path otherwise. */
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
  /** "5432/tcp" — the port inside the container. */
  containerPort: string;
  /** "0.0.0.0:5432", or null when the port is exposed but not published. */
  published: string | null;
}

/**
 * Everything the drawer shows about ONE container.
 *
 * `envNames` and not `env`: `docker inspect` renders `Config.Env` in the
 * CLEAR, and a service's variables are encrypted at rest precisely so that
 * they are not readable from a screen. The names answer the question that
 * is actually asked — "is DATABASE_URL even set in there" — and carry no
 * secret.
 */
export interface ContainerDetail {
  command: string;
  createdAt: string;
  envNames: string[];
  /** Docker's own health verdict, when the image declares a HEALTHCHECK.
   *  `null` when it declares none — which is NOT "unhealthy". */
  health: string | null;
  id: string;
  image: string;
  kind: ContainerKind;
  mounts: ContainerMount[];
  name: string;
  networks: ContainerNetwork[];
  ports: ContainerPort[];
  /** "always", "unless-stopped", "no"… — as Docker records it. */
  restartPolicy: string;
  state: string;
}

/**
 * A container's kind, decided in this ORDER.
 *
 * Swarm first: a control-plane task (Traefik deployed as a service on some
 * installations) remains a task, and "restart the service" is the right
 * action there — non-destructive, since Swarm replaces the task.
 */
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
  // The build daemon carries no labels at all — measured, `{}` — so the
  // NAME is the only thing that identifies it, and that name lives in
  // `@noddle/shared` beside the code that starts it. Removing it would
  // strip Noddle of its ability to build, from a Noddle screen.
  if (isNoddleOwnedContainer(o.name)) {
    return "control-plane";
  }
  return "unmanaged";
}

/** Parses the tab-separated output. A malformed line is IGNORED rather than
 *  rendered halfway: a container of unknown kind would get offered the
 *  default kind's actions. */
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

/** Anything not an object is an empty object: one missing branch of
 *  `docker inspect` must not take the whole drawer down with it. */
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
      // Absent means read-write: Docker only writes `false` when it is not.
      readWrite: mount.RW !== false,
      // The NAME first: a named volume's `Source` is a 64-character path
      // under /var/lib/docker, which identifies nothing to a reader.
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

/** A port with no binding is EXPOSED, not published — and that difference
 *  is the whole answer to "why can I not reach it". */
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

/**
 * The NAMES of the environment variables, never their values.
 *
 * Sorted by code point rather than `localeCompare`: this runs on the
 * server and the result is serialized to the client, so a comparison that
 * depends on the runtime's locale would order the same list two ways.
 */
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

/**
 * `docker inspect --format '{{json .}}'` for one container.
 *
 * Exported separately from the command that produces it so the shape can
 * be verified against a recorded payload without a machine — the parsing
 * is where this feature can silently go wrong, not the SSH call.
 */
export function parseInspect(stdout: string): ContainerDetail {
  const parsed: unknown = JSON.parse(stdout);
  // `docker inspect` without a format returns an ARRAY; with `{{json .}}`
  // it returns the object. Accept both rather than depend on the caller.
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
    // Docker writes an EMPTY name when the container has no policy at all,
    // and "no" is what its own CLI calls that.
    restartPolicy: policy || "no",
    state: text(state.Status),
  };
}

/**
 * Re-reads the container's KIND on the machine, right before acting.
 *
 * Client-side hiding is only a courtesy; this is where the rule actually
 * lives. Without this re-read, a forged call could remove `postgres` or
 * `web` — the control plane — while claiming to target an ordinary
 * container. And the page may have been loaded an hour ago: a container can
 * have changed nature in the meantime.
 */
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
