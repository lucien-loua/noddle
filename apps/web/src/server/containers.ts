import { databases, servers } from "@noddle/db/schema";
import { swarmServiceName } from "@noddle/shared/swarm-names";
import { execArgv, type SshClient } from "@noddle/ssh-executor";
import { createServerFn } from "@tanstack/react-start";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db.server";
import { runGuarded } from "@/lib/permission.server";
import { enqueueDeploy } from "@/lib/queue.server";
import { requireSession } from "@/lib/session.server";
import { withServerSession, withServerSessionById } from "@/lib/ssh.server";

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
      try {
        // One machine at a time: parallelizing would open N SSH sessions
        // from a 2GB control plane just to read a list. Same discipline as
        // the worker's own passes.
        // biome-ignore lint/performance/noAwaitInLoops: deliberately sequential
        await withServerSession(server, async (client) => {
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
        });
      } catch (err) {
        view.unreachable.push({
          reason: err instanceof Error ? err.message : String(err),
          serverId: server.id,
          serverName: server.name,
        });
      }
    }
    return view;
  }
);

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
    // as everywhere else in the role model. Computed BEFORE the call:
    // runGuarded takes one permission, not a function of the payload.
    const permission = {
      action: (data.action === "remove" ? "delete" : "operate") as
        | "delete"
        | "operate",
      resource: "container" as const,
    };

    // The object is a container, not a row — so no `load`; its name comes
    // back from the machine inside `run` and the target reads the result.
    const guarded = await runGuarded({
      permission,
      run: async () =>
        withServerSessionById(data.serverId, async (client) => {
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

          const argv =
            data.action === "remove"
              ? ["sudo", "docker", "rm", data.containerId]
              : ["sudo", "docker", data.action, data.containerId];
          const res = await execArgv(client, argv);
          if (res.code !== 0) {
            throw new Error(
              res.stderr.trim() || `docker ${data.action} failed`
            );
          }
          return { containerName: found.name, done: true as const };
        }),
      target: ({ result }) => ({
        id: data.containerId,
        name: result.containerName,
      }),
    });
    return { done: guarded.done };
  });

const restartServiceSchema = z.object({
  serverId: z.string().uuid(),
  serviceName: z.string().min(1),
});

/**
 * True when `serviceName` belongs to a row Noddle manages.
 *
 * Client-side hiding is only a courtesy; this is where the rule actually
 * lives for Swarm restarts. Without it, a forged call could ForceUpdate
 * Traefik, the registry, or Noddle's own web/worker — anything the
 * manager will accept by name.
 */
async function isManagedSwarmService(serviceName: string): Promise<boolean> {
  const [svcRows, dbRow, stackRows] = await Promise.all([
    db.query.services.findMany({ columns: { id: true, name: true } }),
    db.query.databases.findFirst({
      columns: { id: true },
      where: eq(databases.swarmName, serviceName),
    }),
    db.query.stacks.findMany({ columns: { swarmName: true } }),
  ]);

  if (svcRows.some((s) => swarmServiceName(s) === serviceName)) {
    return true;
  }
  if (dbRow) {
    return true;
  }
  // Compose services are `<swarmName>_<key>`; the stack namespace itself
  // is also a legitimate match if ever targeted directly.
  return stackRows.some(
    (s) =>
      serviceName === s.swarmName || serviceName.startsWith(`${s.swarmName}_`)
  );
}

/**
 * Restarts a Swarm task's SERVICE — the only honest action on it.
 *
 * Placed on the deployment queue rather than executed here, unlike the
 * actions above: this is a Swarm mutation, it has to go through the
 * manager, and a `ForceUpdate` while a deployment of the same service is
 * converging would be two updates crossing paths. This queue's concurrency
 * of 1 is what forbids that — same rule as rollback, deletion, and the
 * lifecycle.
 *
 * Ownership is re-checked here (inventory + live kind on `serverId`), the
 * same seam `containerAction` uses for stop/restart/remove. A name alone
 * is never enough.
 */
export const restartSwarmService = createServerFn({ method: "POST" })
  .validator(restartServiceSchema)
  .handler(
    async ({ data }): Promise<{ queued: true }> =>
      runGuarded({
        permission: { action: "operate", resource: "container" },
        // The Swarm service name IS the object here; there is no local row
        // for it, so the target is built from the payload after the
        // ownership check inside `run` has accepted it.
        run: async () => {
          if (!(await isManagedSwarmService(data.serviceName))) {
            throw new Error(
              `${data.serviceName} is not a Noddle-managed Swarm service and cannot be restarted from here.`
            );
          }

          await withServerSessionById(data.serverId, async (client) => {
            const res = await execArgv(client, [
              "sudo",
              "docker",
              "ps",
              "-a",
              "--no-trunc",
              "--filter",
              `label=com.docker.swarm.service.name=${data.serviceName}`,
              "--format",
              PS_FORMAT,
            ]);
            if (res.code !== 0) {
              throw new Error(res.stderr.trim() || "docker ps failed");
            }
            const rows = parsePs(res.stdout, { id: data.serverId, name: "" });
            if (rows.length === 0) {
              throw new Error(
                `no running task for Swarm service ${data.serviceName} on that server`
              );
            }
            const foreign = rows.find((r) => r.kind !== "swarm");
            if (foreign) {
              throw new Error(
                `${foreign.name} is part of Noddle itself and cannot be changed from here.`
              );
            }
          });

          await enqueueDeploy({
            kind: "restart-swarm-service",
            serviceName: data.serviceName,
          });
          return { queued: true as const };
        },
        target: () => ({ id: data.serviceName, name: data.serviceName }),
      })
  );
