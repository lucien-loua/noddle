import { servers, sshKeys } from "@noddle/db/schema";
import { decryptSecret, secretContext } from "@noddle/shared/crypto";
import { connect, disconnect, execArgv } from "@noddle/ssh-executor";
import { createServerFn } from "@tanstack/react-start";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db.server";
import { env } from "@/lib/env.server";
import { requirePermission } from "@/lib/permission.server";
import { enqueueDeploy } from "@/lib/queue.server";
import { requireSession } from "@/lib/session.server";

/**
 * The capped builder's container, as buildx names it.
 *
 * It has to be recognized by NAME, and that's a deliberate exception:
 * measured, its labels are **entirely empty** (`{}`). Without this special
 * case it would pass for an ordinary container and get offered "Remove" —
 * which would strip Noddle of its ability to build, from a Noddle screen.
 *
 * The name is deterministic: buildx derives `buildx_buildkit_<builder>0`
 * from the builder's name, and that name is a worker constant
 * (`noddle-builder`).
 */
const BUILDER_CONTAINER = "buildx_buildkit_noddle-builder0";

/** The Compose project of the control plane's stack. */
const CONTROL_PLANE_PROJECT = "noddle";

/**
 * The fields requested from `docker ps`, separated by TABS.
 *
 * Not `{{json .}}`: it flattens labels into a single "k=v,k=v" string, and a
 * VALUE can contain a comma — measured, `com.docker.compose.depends_on`
 * contains one. Splitting on it would corrupt the read. So we explicitly
 * request only the two labels that decide the kind, which removes the
 * problem instead of working around it.
 *
 * A tab can't appear in a container name, an image reference, or the
 * `Status` Docker formats.
 */
const PS_FORMAT = [
  "{{.ID}}",
  "{{.Names}}",
  "{{.Image}}",
  "{{.State}}",
  "{{.Status}}",
  '{{.Label "com.docker.swarm.service.name"}}',
  '{{.Label "com.docker.compose.project"}}',
].join("\\t");

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

export interface ContainersView {
  containers: ContainerRow[];
  /** The machines that didn't respond. A gap is a gap: we don't pretend
   *  they have nothing on them. */
  unreachable: { serverId: string; serverName: string; reason: string }[];
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
  if (o.name === BUILDER_CONTAINER) {
    return "control-plane";
  }
  return "unmanaged";
}

const FIELDS = 7;

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
    if (parts.length !== FIELDS) {
      continue;
    }
    const [id, name, image, state, status, swarmService, composeProject] =
      parts as [string, string, string, string, string, string, string];
    rows.push({
      createdAt: "",
      id,
      image,
      kind: classify({ composeProject, name, swarmService }),
      name,
      serverId: server.id,
      serverName: server.name,
      serviceName: swarmService || null,
      state,
      status,
    });
  }
  return rows;
}

export const getContainers = createServerFn({ method: "GET" }).handler(
  async (): Promise<ContainersView> => {
    // `requireSession` and not `requirePermission`: all four roles have
    // `server: read`, so a guard would refuse nobody and would write an
    // audit line per page view — the hole through which /audit would bury
    // its own signal.
    await requireSession();

    const view: ContainersView = { containers: [], unreachable: [] };
    const connected = await db.query.servers.findMany({
      orderBy: servers.name,
      where: eq(servers.status, "connected"),
    });

    for (const server of connected) {
      let client: Awaited<ReturnType<typeof connect>> | undefined;
      try {
        // One machine at a time: parallelizing would open N SSH sessions
        // from a 2GB control plane just to read a list. Same discipline as
        // the worker's own passes.
        // biome-ignore lint/performance/noAwaitInLoops: deliberately sequential
        const key = await db.query.sshKeys.findFirst({
          where: eq(sshKeys.id, server.sshKeyId),
        });
        if (!key) {
          throw new Error("SSH key not found");
        }
        client = await connect({
          host: server.host,
          port: server.sshPort,
          privateKey: decryptSecret(
            key.privateKeyEncrypted,
            env.appKey,
            secretContext.sshKey(key.id)
          ),
          user: server.sshUser,
        });
        // `-a`: a stopped container is precisely what we're looking for
        // here, and it's the one the daily prune will remove.
        const res = await execArgv(client, [
          "sudo",
          "docker",
          "ps",
          "-a",
          "--format",
          PS_FORMAT,
        ]);
        if (res.code !== 0) {
          throw new Error(res.stderr.trim() || "docker ps failed");
        }
        view.containers.push(...parsePs(res.stdout, server));
      } catch (err) {
        view.unreachable.push({
          reason: err instanceof Error ? err.message : String(err),
          serverId: server.id,
          serverName: server.name,
        });
      } finally {
        if (client) {
          disconnect(client);
        }
      }
    }
    return view;
  }
);

/**
 * Opens a session to a given server, by its id.
 *
 * The actions target a SPECIFIC machine — the one the container runs on —
 * and not the manager: stopping a container is an operation local to its
 * daemon.
 */
async function connectToServer(serverId: string) {
  const server = await db.query.servers.findFirst({
    where: eq(servers.id, serverId),
  });
  if (!server) {
    throw new Error("server not found");
  }
  const key = await db.query.sshKeys.findFirst({
    where: eq(sshKeys.id, server.sshKeyId),
  });
  if (!key) {
    throw new Error("SSH key not found");
  }
  return await connect({
    host: server.host,
    port: server.sshPort,
    privateKey: decryptSecret(
      key.privateKeyEncrypted,
      env.appKey,
      secretContext.sshKey(key.id)
    ),
    user: server.sshUser,
  });
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
async function readKind(
  client: Awaited<ReturnType<typeof connect>>,
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

const containerActionSchema = z.object({
  action: z.enum(["stop", "restart", "remove"]),
  containerId: z.string().min(1),
  serverId: z.string().uuid(),
});

/**
 * Stop / Restart / Remove — and ONLY on an unmanaged container.
 *
 * The refusal isn't a UI courtesy: on a Swarm task these commands are a
 * disguised no-op (Swarm reschedules immediately, and the screen would have
 * announced a stop that didn't happen), and on the control plane they
 * destroy what you're clicking from.
 */
export const containerAction = createServerFn({ method: "POST" })
  .validator(containerActionSchema)
  .handler(async ({ data }): Promise<{ done: true }> => {
    // `remove` can't be undone, the other two can. The boundary is the same
    // as everywhere else in the role model.
    await requirePermission({
      action: data.action === "remove" ? "delete" : "operate",
      resource: "container",
    });

    const client = await connectToServer(data.serverId);
    try {
      const found = await readKind(client, data.containerId);
      if (!found) {
        throw new Error("container not found");
      }
      if (found.kind !== "unmanaged") {
        throw new Error(
          found.kind === "swarm"
            ? `${found.name} is a Swarm task — restart its service instead, stopping the container only makes Swarm reschedule it.`
            : `${found.name} is part of Noddle itself and cannot be changed from here.`
        );
      }

      // Never `-f` on `rm`: Docker refuses to remove a RUNNING container
      // without it, and that refusal is a protection we keep rather than
      // work around. It has to be stopped first, explicitly.
      const argv =
        data.action === "remove"
          ? ["sudo", "docker", "rm", data.containerId]
          : ["sudo", "docker", data.action, data.containerId];
      const res = await execArgv(client, argv);
      if (res.code !== 0) {
        throw new Error(res.stderr.trim() || `docker ${data.action} failed`);
      }
      return { done: true };
    } finally {
      disconnect(client);
    }
  });

const restartServiceSchema = z.object({ serviceName: z.string().min(1) });

/**
 * Restarts a Swarm task's SERVICE — the only honest action on it.
 *
 * Placed on the deployment queue rather than executed here, unlike the
 * actions above: this is a Swarm mutation, it has to go through the
 * manager, and a `ForceUpdate` while a deployment of the same service is
 * converging would be two updates crossing paths. This queue's concurrency
 * of 1 is what forbids that — same rule as rollback, deletion, and the
 * lifecycle.
 */
export const restartSwarmService = createServerFn({ method: "POST" })
  .validator(restartServiceSchema)
  .handler(async ({ data }): Promise<{ queued: true }> => {
    await requirePermission({ action: "operate", resource: "container" });
    await enqueueDeploy({
      kind: "restart-swarm-service",
      serviceName: data.serviceName,
    });
    return { queued: true };
  });
