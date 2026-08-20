import { databases, servers } from "@noddle/db/schema";
import { swarmServiceName } from "@noddle/shared/swarm-names";
import { execArgv } from "@noddle/ssh-executor";
import { createServerFn } from "@tanstack/react-start";
import { eq } from "drizzle-orm";
import { z } from "zod";

import {
  CONTAINER_ID,
  parseInspect,
  parsePs,
  PS_FORMAT,
  readKind,
} from "@/lib/container-read.server";
import type {
  ContainerDetail,
  ContainerRow,
} from "@/lib/container-read.server";
import { db } from "@/lib/db.server";
import { runGuarded } from "@/lib/permission.server";
import { enqueueDeploy } from "@/lib/queue.server";
import { requireSession } from "@/lib/session.server";
import { withServerSession, withServerSessionById } from "@/lib/ssh.server";

/**
 * The kind, the `docker ps` format and the parsing live in
 * `container-read.server`, not here: the terminal WebSocket needs the same
 * rule and cannot import a module that pulls in `createServerFn`. Re-exported
 * as TYPES so the screens keep one import for this feature.
 */
export type {
  ContainerDetail,
  ContainerKind,
  ContainerRow,
} from "@/lib/container-read.server";

export interface ContainersView {
  containers: ContainerRow[];
  /** The machines that didn't respond. A gap is a gap: we don't pretend
   *  they have nothing on them. */
  unreachable: { serverId: string; serverName: string; reason: string }[];
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
      } catch (error) {
        view.unreachable.push({
          reason: error instanceof Error ? error.message : String(error),
          serverId: server.id,
          serverName: server.name,
        });
      }
    }
    return view;
  }
);

const inspectSchema = z.object({
  containerId: z.string().regex(CONTAINER_ID),
  serverId: z.uuid(),
});

/**
 * What one container is MADE OF — ports, mounts, networks, restart policy.
 *
 * `requireSession` and not `requirePermission`, exactly like `getContainers`
 * above: this reads, it does not touch, and a guard here would refuse nobody
 * while writing an audit line per drawer opened.
 *
 * The kind is read from the machine's own labels rather than trusted from
 * the row that opened the drawer: it decides whether a shell is offered.
 */
export const inspectContainer = createServerFn({ method: "GET" })
  .validator(inspectSchema)
  .handler(async ({ data }): Promise<ContainerDetail> => {
    await requireSession();
    return withServerSessionById(data.serverId, async (client) => {
      const res = await execArgv(client, [
        "sudo",
        "docker",
        "inspect",
        "--format",
        "{{json .}}",
        data.containerId,
      ]);
      if (res.code !== 0) {
        throw new Error(res.stderr.trim() || "docker inspect failed");
      }
      return parseInspect(res.stdout);
    });
  });

const containerActionSchema = z.object({
  action: z.enum(["stop", "restart", "remove"]),
  containerId: z.string().min(1),
  serverId: z.uuid(),
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
                ? `${found.name} is a Swarm task: restart its service instead, stopping the container only makes Swarm reschedule it.`
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
  serverId: z.uuid(),
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
  .handler(async ({ data }): Promise<{ queued: true }> =>
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
