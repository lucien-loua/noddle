import { databases, servers } from "@noddle/db/schema";
import { execStream, quoteArg } from "@noddle/ssh-executor";
import { createFileRoute } from "@tanstack/react-router";
import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth.server";
import { db } from "@/lib/db.server";
import { sseChannel } from "@/lib/sse-channel.server";
import { connectToServer } from "@/lib/ssh.server";

/** The catch-up window. Enough to see a full startup. */
const DEFAULT_TAIL = 500;
const MAX_TAIL = 5000;

const SINCE_VALUES = new Set(["all", "1h", "6h", "24h", "168h", "720h"]);

const UUID = /^[0-9a-f-]{36}$/i;

/** The label Swarm sets on each task's container. */
const SWARM_SERVICE_LABEL = "com.docker.swarm.service.name";

/**
 * The remote command — quirks measured on a real VM (see git history for
 * the full rationale on container vs service logs, 2>&1, and stdin guard).
 */
function tailCommand(swarmName: string, tail: number, since: string): string {
  const filter = quoteArg(`label=${SWARM_SERVICE_LABEL}=${swarmName}`);
  const sinceFlag = since === "all" ? "" : ` --since ${quoteArg(since)}`;
  return [
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

        const server = await db.query.servers.findFirst({
          where: eq(servers.id, database.serverId),
        });
        if (!server) {
          return new Response("server not found", { status: 404 });
        }

        return sseChannel(request, async ({ closed, finish, send }) => {
          let leave: (() => void) | undefined;
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

            if (result.code === 3) {
              send({
                data: "No container for this database yet.\n",
                type: "chunk",
              });
            }
            send({ status: "ended", type: "end" });
          } catch (error) {
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

          return () => leave?.();
        });
      },
    },
  },
});
