import { databases, servers } from "@noddle/db/schema";
import type { LogMessage } from "@noddle/shared/logs";
import { execStream, quoteArg } from "@noddle/ssh-executor";
import { createFileRoute } from "@tanstack/react-router";
import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth.server";
import { db } from "@/lib/db.server";
import { connectToServer } from "@/lib/ssh.server";

/** Same reason as on the build stream: a proxy cuts an idle connection, and
 *  a healthy database can stay silent for hours. */
const HEARTBEAT_MS = 25_000;

/** The catch-up window. Enough to see a full startup. */
const DEFAULT_TAIL = 500;
const MAX_TAIL = 5000;

const SINCE_VALUES = new Set(["all", "1h", "6h", "24h", "168h", "720h"]);

const UUID = /^[0-9a-f-]{36}$/i;

/** The label Swarm sets on each task's container. */
const SWARM_SERVICE_LABEL = "com.docker.swarm.service.name";

/**
 * The remote command, and each of its three quirks was measured on a real
 * VM before being written.
 *
 * **1. `docker logs` on the CONTAINER, not `docker service logs`.** The
 * latter looks more correct — it survives a task being replaced — but it
 * CONCATENATES tasks instead of merging them in time order. Measured on the
 * development database, which has four tasks in its Swarm history: the
 * output jumped from 23:08 back to 21:44, ninety minutes backwards, and
 * `--tail N` applies PER TASK. A log that goes back in time without saying
 * so is exactly the screen that lies. A container, on the other hand, is
 * strictly chronological.
 *
 * **2. `2>&1` isn't a convenience, it's the condition for seeing anything at
 * all.** Postgres writes its log to the ERROR stream; measured on the
 * development database, 9,869 bytes on stderr versus 791 on stdout, i.e. 93%
 * of the log. Without the redirection, the tab would show ten lines of
 * entrypoint chatter and nothing from the engine — and `execStream` CAPS
 * stderr at 64 KiB, so the rest would be silently truncated.
 *
 * **3. The guard on standard input.** Measured: destroying the ssh2 channel
 * does NOT kill the remote `docker logs --follow` — it survives the tab
 * closing and only learns it's alone on its next write, which is to say
 * never on a quiet database. Every closed tab would therefore leave a
 * process behind. `cat` reads the channel's input: it yields EOF when the
 * viewer leaves, and we then kill the follower.
 *
 * `exec 3<&0` is what makes the guard possible: a background job inherits
 * `/dev/null` as input when job control is off — measured, the guard was
 * seeing EOF immediately and killing the follower before its first line.
 * And the `wait` targets the FOLLOWER, not the guard: without that, a
 * container that dies would leave the stream open and silent instead of
 * ending.
 *
 * No pipe, so no `cmd | grep -q` race — already paid for in Phase 0.
 */
function tailCommand(swarmName: string, tail: number, since: string): string {
  const filter = quoteArg(`label=${SWARM_SERVICE_LABEL}=${swarmName}`);
  const sinceFlag = since === "all" ? "" : ` --since ${quoteArg(since)}`;
  return [
    // `-a` and `-l`: the most RECENT container even if it's dead. That's the
    // case where the logs are needed the most — a database that fails to
    // start has no running container to query.
    `C=$(docker ps -a -q -l --filter ${filter})`,
    `if [ -z "$C" ]; then exit 3; fi`,
    "exec 3<&0",
    `docker logs --tail ${tail}${sinceFlag} --follow "$C" 2>&1 & L=$!`,
    '{ cat <&3 >/dev/null; kill "$L" 2>/dev/null; } &',
    'wait "$L"',
  ].join("\n");
}

function parseTail(raw: string | null): number {
  if (!raw) {
    return DEFAULT_TAIL;
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) {
    return DEFAULT_TAIL;
  }
  return Math.min(n, MAX_TAIL);
}

function parseSince(raw: string | null): string {
  if (!(raw && SINCE_VALUES.has(raw))) {
    return "all";
  }
  return raw;
}

export const Route = createFileRoute("/api/database-logs/$databaseId")({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        // A session is enough, and it's the same trade-off as for disk
        // breakdown: the test that separates `requirePermission` from
        // `requireSession` is "is there a role that does NOT have this
        // permission". All four have `database: read` — `viewer` is even
        // described as "read-only, logs included" — so a guard would refuse
        // nobody here and would write an audit line per opened tab, the hole
        // through which /audit would bury its own signal.
        const session = await auth.api.getSession({ headers: request.headers });
        if (!session) {
          return new Response("not authenticated", { status: 401 });
        }

        const { databaseId } = params;
        if (!UUID.test(databaseId)) {
          return new Response("invalid id", { status: 400 });
        }

        const url = new URL(request.url);
        const tail = parseTail(url.searchParams.get("tail"));
        const since = parseSince(url.searchParams.get("since"));

        const database = await db.query.databases.findFirst({
          where: eq(databases.id, databaseId),
        });
        if (!database) {
          return new Response("database not found", { status: 404 });
        }

        // The database's own server, never the manager: its volume only
        // exists on that node, so its container is there by construction.
        // The manager would have nothing to show.
        const server = await db.query.servers.findFirst({
          where: eq(servers.id, database.serverId),
        });
        if (!server) {
          return new Response("server not found", { status: 404 });
        }

        const encoder = new TextEncoder();

        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            let closed = false;
            let heartbeat: ReturnType<typeof setInterval> | undefined;
            /** Closes the remote process's input: it's THIS signal that
             *  makes it die, not the channel being destroyed. */
            let leave: (() => void) | undefined;

            const finish = () => {
              if (closed) {
                return;
              }
              closed = true;
              if (heartbeat) {
                clearInterval(heartbeat);
              }
              leave?.();
              try {
                controller.close();
              } catch {
                // already closed by the client
              }
            };

            const send = (message: LogMessage) => {
              if (closed) {
                return;
              }
              try {
                controller.enqueue(
                  encoder.encode(
                    `event: ${message.type}\ndata: ${JSON.stringify(message)}\n\n`
                  )
                );
              } catch {
                finish();
              }
            };

            request.signal.addEventListener("abort", finish);

            heartbeat = setInterval(() => {
              if (closed) {
                return;
              }
              try {
                controller.enqueue(encoder.encode(": ping\n\n"));
              } catch {
                finish();
              }
            }, HEARTBEAT_MS);

            let client: Awaited<ReturnType<typeof connectToServer>> | undefined;
            try {
              client = await connectToServer(server);
              const result = await execStream(
                client,
                tailCommand(database.swarmName, tail, since),
                (io) =>
                  new Promise<void>((resolve, reject) => {
                    leave = () => {
                      io.stdin.end();
                      reject(new Error("viewer left"));
                    };
                    io.stdout.on("data", (chunk: Buffer) =>
                      send({ data: chunk.toString("utf8"), type: "chunk" })
                    );
                    io.stdout.on("end", () => resolve());
                    io.stdout.on("error", reject);
                  })
              );

              // 3 is the code the command returns when no container carries
              // the label — never provisioned, or already torn down.
              if (result.code === 3) {
                send({
                  data: "No container for this database yet.\n",
                  type: "chunk",
                });
              }
              send({ status: "ended", type: "end" });
            } catch (error) {
              // The viewer leaving goes through here: `finish` has already
              // closed everything, there's nothing to say.
              if (!closed) {
                send({
                  data: `Could not read logs: ${
                    error instanceof Error ? error.message : String(error)
                  }\n`,
                  type: "chunk",
                });
                send({ status: "error", type: "end" });
              }
            } finally {
              client?.end();
              finish();
            }
          },
        });

        return new Response(stream, {
          headers: {
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "Content-Type": "text/event-stream",
            "X-Accel-Buffering": "no",
          },
        });
      },
    },
  },
});
