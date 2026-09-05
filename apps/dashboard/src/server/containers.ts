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

export type {
  ContainerDetail,
  ContainerKind,
  ContainerRow,
} from "@/lib/container-read.server";

export interface ContainersView {
  containers: ContainerRow[];
  unreachable: { serverId: string; serverName: string; reason: string }[];
}

export const getContainers = createServerFn({ method: "GET" }).handler(
  async (): Promise<ContainersView> => {
    await requireSession();

    const view: ContainersView = { containers: [], unreachable: [] };
    const connected = await db.query.servers.findMany({
      orderBy: servers.name,
      where: eq(servers.status, "connected"),
    });

    for (const server of connected) {
      try {
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
  containerId: z.string().regex(CONTAINER_ID, "Choose a container."),
  serverId: z.uuid("Choose a server."),
});

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
  action: z.enum(["stop", "restart", "remove"], "Choose an action."),
  containerId: z.string().min(1, "Choose a container."),
  serverId: z.uuid("Choose a server."),
});

export const containerAction = createServerFn({ method: "POST" })
  .validator(containerActionSchema)
  .handler(async ({ data }): Promise<{ done: true }> => {
    const permission = {
      action: (data.action === "remove" ? "delete" : "operate") as
        | "delete"
        | "operate",
      resource: "container" as const,
    };

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
  serverId: z.uuid("Choose a server."),
  serviceName: z.string().min(1, "Enter the service name."),
});

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
  return stackRows.some(
    (s) =>
      serviceName === s.swarmName || serviceName.startsWith(`${s.swarmName}_`)
  );
}

export const restartSwarmService = createServerFn({ method: "POST" })
  .validator(restartServiceSchema)
  .handler(async ({ data }): Promise<{ queued: true }> =>
    runGuarded({
      permission: { action: "operate", resource: "container" },
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
