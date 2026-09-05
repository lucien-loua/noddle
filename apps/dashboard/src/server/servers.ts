import {
  databases,
  servers,
  services,
  sshKeys,
  stacks,
} from "@noddle/db/schema";
import { RAILPACK_VERSION } from "@noddle/shared/toolchain";
import {
  deleteServerSchema,
  serverInputSchema,
} from "@noddle/shared/validation/server";
import { exec } from "@noddle/ssh-executor";
import { createServerFn } from "@tanstack/react-start";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db.server";
import { guarded, identityTarget } from "@/lib/guarded.server";
import { runGuarded } from "@/lib/permission.server";
import { enqueueDeploy } from "@/lib/queue.server";
import { requireSession } from "@/lib/session.server";
import { withServerSessionById } from "@/lib/ssh.server";

export interface ServerView {
  createdAt: string;
  dockerVersion: string | null;
  host: string;
  id: string;
  isSelf: boolean;
  lastError: string | null;
  name: string;
  pruneEnabled: boolean;
  role: "manager" | "worker";
  status: "connected" | "pending" | "unreachable";
  totalMemoryMb: number | null;
}

export const getServers = createServerFn({ method: "GET" }).handler(
  async (): Promise<ServerView[]> => {
    await requireSession();

    const rows = await db.query.servers.findMany({
      orderBy: desc(servers.isSelf),
    });

    return rows.map((row) => ({
      createdAt: row.createdAt.toISOString(),
      dockerVersion: row.dockerVersion,
      host: row.host,
      id: row.id,
      isSelf: row.isSelf,
      lastError: row.lastError,
      name: row.name,
      pruneEnabled: row.pruneEnabled,
      role: row.role,
      status: row.status,
      totalMemoryMb: row.totalMemoryMb,
    }));
  }
);

export const addServer = createServerFn({ method: "POST" })
  .validator(serverInputSchema)
  .handler(async ({ data }): Promise<{ serverId: string }> => {
    const outcome = await runGuarded({
      permission: { action: "create", resource: "server" },
      run: async () => {
        const key = await db.query.sshKeys.findFirst({
          where: eq(sshKeys.id, data.sshKeyId),
        });
        if (!key) {
          throw new Error("that SSH key no longer exists: pick another one");
        }

        const [created] = await db
          .insert(servers)
          .values({
            host: data.host,
            name: data.name,
            sshKeyId: data.sshKeyId,
            sshPort: data.sshPort,
            sshUser: data.sshUser,
          })
          .returning();
        if (!created) {
          throw new Error("could not register server");
        }

        await enqueueDeploy({ kind: "provision-server", serverId: created.id });

        return { name: created.name, serverId: created.id };
      },
      target: ({ result }) => ({ id: result.serverId, name: result.name }),
    });

    return { serverId: outcome.serverId };
  });

const setServerPruneEnabledSchema = z.object({
  enabled: z.boolean(),
  serverId: z.uuid("Choose a server."),
});

export const setServerPruneEnabled = createServerFn({ method: "POST" })
  .validator(setServerPruneEnabledSchema)
  .handler(async ({ data }): Promise<{ done: true }> =>
    runGuarded({
      ...guarded.server(data.serverId),
      permission: { action: "update", resource: "server" },
      run: async ({ row }) => {
        await db
          .update(servers)
          .set({ pruneEnabled: data.enabled })
          .where(eq(servers.id, row.id));
        return { done: true as const };
      },
      target: identityTarget,
    })
  );

export const deleteServer = createServerFn({ method: "POST" })
  .validator(deleteServerSchema)
  .handler(async ({ data }): Promise<{ ok: true }> =>
    runGuarded({
      confirmName: { expected: (row) => row.name, typed: data.confirmName },
      ...guarded.server(data.serverId),
      permission: { action: "delete", resource: "server" },
      run: async ({ row: server }) => {
        if (server.role === "manager") {
          throw new Error(
            "this is the Swarm manager: removing it would leave the installation unable to deploy anything"
          );
        }

        const held = await heldBy(server.id);
        if (held) {
          throw new Error(
            `this server still hosts ${held}: move or delete them first`
          );
        }

        await enqueueDeploy({ kind: "delete-server", serverId: server.id });
        return { ok: true as const };
      },
      target: identityTarget,
    })
  );

async function heldBy(serverId: string): Promise<string | null> {
  const [svc, stk, dbs] = await Promise.all([
    db.query.services.findMany({ where: eq(services.serverId, serverId) }),
    db.query.stacks.findMany({ where: eq(stacks.serverId, serverId) }),
    db.query.databases.findMany({ where: eq(databases.serverId, serverId) }),
  ]);
  const held = [
    svc.length ? `${svc.length} service(s)` : "",
    stk.length ? `${stk.length} stack(s)` : "",
    dbs.length ? `${dbs.length} database(s)` : "",
  ].filter(Boolean);
  return held.length > 0 ? held.join(", ") : null;
}

const serverIdSchema = z.object({ serverId: z.uuid("Choose a server.") });

export interface ServerToolReport {
  docker: string | null;
  railpack: string | null;
  railpackExpected: string;
  swarm: string;
}

export const checkServerTools = createServerFn({ method: "GET" })
  .validator(serverIdSchema)
  .handler(async ({ data }): Promise<ServerToolReport> => {
    await requireSession();

    const row = await db.query.servers.findFirst({
      where: eq(servers.id, data.serverId),
    });
    if (!row) {
      throw new Error("server not found");
    }

    return await withServerSessionById(row.id, async (client) => {
      const version = async (command: string) => {
        const r = await exec(client, command);
        const out = r.stdout.trim();
        return r.code === 0 && out !== "" ? out : null;
      };
      return {
        docker: await version("docker --version"),
        railpack: await version("railpack --version"),
        railpackExpected: RAILPACK_VERSION,
        swarm:
          (await version(
            "sudo docker info --format '{{.Swarm.LocalNodeState}}'"
          )) ?? "unknown",
      };
    });
  });

export const setupServer = createServerFn({ method: "POST" })
  .validator(serverIdSchema)
  .handler(async ({ data }): Promise<{ ok: true }> =>
    runGuarded({
      ...guarded.server(data.serverId),
      permission: { action: "create", resource: "server" },
      run: async ({ row }) => {
        await enqueueDeploy({ kind: "provision-server", serverId: row.id });
        return { ok: true as const };
      },
      target: identityTarget,
    })
  );
