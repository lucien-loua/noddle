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

    // The encrypted key NEVER leaves here, not even encrypted: a server
    // function only returns what the screen needs to display.
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
    const guarded = await runGuarded({
      permission: { action: "create", resource: "server" },
      run: async () => {
        // The key is REFERENCED, no longer copied: a single insert is now
        // enough, whereas the AAD bound to the server's row used to require
        // inserting a "placeholder" and then rewriting it.
        //
        // Checked for existence here rather than left to the foreign key:
        // Postgres would also reject it, but with a message nobody can read.
        const key = await db.query.sshKeys.findFirst({
          where: eq(sshKeys.id, data.sshKeyId),
        });
        if (!key) {
          throw new Error("that SSH key no longer exists — pick another one");
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

        // The worker does the rest: Docker if missing, joining the Swarm
        // cluster AS A WORKER (never manager — a second manager would change
        // the Raft quorum size without being asked to), railpack, then the same
        // facts as machine #1.
        await enqueueDeploy({ kind: "provision-server", serverId: created.id });

        return { name: created.name, serverId: created.id };
      },
      target: ({ result }) => ({ id: result.serverId, name: result.name }),
    });

    return { serverId: guarded.serverId };
  });

const setServerPruneEnabledSchema = z.object({
  enabled: z.boolean(),
  serverId: z.uuid(),
});

/**
 * Enables or disables the daily prune ON this server.
 *
 * `update`, not `create`/`delete`: it's a machine setting, never an action
 * on the cluster's topology. Reserved to admin/owner like the rest of the
 * infrastructure settings — a `deployer` ships, they don't configure
 * machines.
 *
 * Disabling only exempts the node FROM the destructive command: it's still
 * polled for registry reconciliation and for its disk breakdown. See
 * `pruneDocker` in the worker.
 */
export const setServerPruneEnabled = createServerFn({ method: "POST" })
  .validator(setServerPruneEnabledSchema)
  .handler(async ({ data }): Promise<{ done: true }> =>
    runGuarded({
      load: () =>
        db.query.servers.findFirst({ where: eq(servers.id, data.serverId) }),
      notFoundMessage: "server not found",
      permission: { action: "update", resource: "server" },
      run: async ({ row }) => {
        await db
          .update(servers)
          .set({ pruneEnabled: data.enabled })
          .where(eq(servers.id, row.id));
        return { done: true as const };
      },
      target: ({ row }) => ({ id: row.id, name: row.name }),
    })
  );

/**
 * Remove a server from the cluster.
 *
 * The REFUSAL is the whole point of this function. Two cases are
 * forbidden, and both are checked here rather than left to the database:
 *
 *   - the MANAGER. Removing it decapitates the installation — no
 *     `docker service create/update` is possible afterward, so no more
 *     deployments, and nothing in the interface would let you recover it.
 *   - a server that still HOSTS something. The foreign keys are `restrict`
 *     and would reject it anyway, but with a Postgres error nobody can
 *     read. We say what's blocking, and how much of it.
 *
 * The check is redone HERE and not only in the worker: the worker runs
 * later, and a refusal that only happens at that point would show up
 * nowhere.
 */
export const deleteServer = createServerFn({ method: "POST" })
  .validator(deleteServerSchema)
  .handler(async ({ data }): Promise<{ ok: true }> =>
    runGuarded({
      confirmName: { expected: (row) => row.name, typed: data.confirmName },
      load: () =>
        db.query.servers.findFirst({ where: eq(servers.id, data.serverId) }),
      notFoundMessage: "server not found",
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
            `this server still hosts ${held} — move or delete them first`
          );
        }

        await enqueueDeploy({ kind: "delete-server", serverId: server.id });
        return { ok: true as const };
      },
      target: ({ row }) => ({ id: row.id, name: row.name }),
    })
  );

/** What the server still hosts, in plain text, or `null`. */
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

const serverIdSchema = z.object({ serverId: z.uuid() });

export interface ServerToolReport {
  /** `null` when the tool is absent. */
  docker: string | null;
  railpack: string | null;
  /** The version Noddle provisions. A mismatch is worth seeing. */
  railpackExpected: string;
  swarm: string;
}

/**
 * What a server actually has, reported and NOT installed.
 *
 * A server added by adoption never went through provisioning, so it can
 * clone and fail to build — which surfaces as `railpack: command not found`
 * in the middle of a deploy, minutes in, pointing at the build rather than
 * at the machine. This makes that legible before a deploy instead of during
 * one.
 */
export const checkServerTools = createServerFn({ method: "GET" })
  .validator(serverIdSchema)
  .handler(async ({ data }): Promise<ServerToolReport> => {
    // `requireSession` alone: `server:read` is universal, and
    // `verify-permissions` rejects a permission guard on a universal GET
    // for the reason that applies here — one audit line per visit, in a
    // log that keeps 200. Asking a machine for its versions changes
    // nothing, and this now loads with the page rather than on a click.
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
        // Queried directly, never `docker info | grep`: these scripts
        // run under pipefail and grep -q makes it a race.
        swarm:
          (await version(
            "sudo docker info --format '{{.Swarm.LocalNodeState}}'"
          )) ?? "unknown",
      };
    });
  });

/**
 * Re-run provisioning on an existing server.
 *
 * It is the SAME job as the one an added server gets, and it is idempotent
 * throughout — it checks before installing Docker, joining the Swarm and
 * installing railpack. So this repairs a server rather than requiring it be
 * removed and added again.
 */
export const setupServer = createServerFn({ method: "POST" })
  .validator(serverIdSchema)
  .handler(async ({ data }): Promise<{ ok: true }> =>
    runGuarded({
      load: () =>
        db.query.servers.findFirst({ where: eq(servers.id, data.serverId) }),
      notFoundMessage: "server not found",
      permission: { action: "create", resource: "server" },
      run: async ({ row }) => {
        await enqueueDeploy({ kind: "provision-server", serverId: row.id });
        return { ok: true as const };
      },
      target: ({ row }) => ({ id: row.id, name: row.name }),
    })
  );
