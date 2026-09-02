import {
  databaseDeployments,
  deployments,
  stackDeployments,
} from "@noddle/db/schema";
import { isTerminalStatus, LOG_BUFFER_MAX_ENTRIES } from "@noddle/shared/logs";
import type { LogEntry } from "@noddle/shared/logs";
import { createFileRoute } from "@tanstack/react-router";
import { eq } from "drizzle-orm";

import { auth } from "@/lib/auth.server";
import { db } from "@/lib/db.server";
import { readArchive } from "@/lib/log-archive.server";
import type { LogArchive } from "@/lib/log-archive.server";
import { OMITTED_NOTICE, parseLastEventId, planReplay } from "@/lib/log-replay";
import { logHub } from "@/lib/redis.server";
import { sseChannel } from "@/lib/sse-channel.server";
import type { SseChannel } from "@/lib/sse-channel.server";

const UUID = /^[0-9a-f-]{36}$/i;

function archiveChunk(archive: LogArchive): string {
  if (archive.kind === "text") {
    return archive.text;
  }
  if (archive.kind === "unreadable") {
    return `(log file unreachable from this process: ${archive.path})\n`;
  }
  return "(no logs kept for this deployment)\n";
}

function replayer(channel: SseChannel, from: number) {
  let delivered = from;

  return {
    deliver(entry: LogEntry) {
      if (entry.seq > 0) {
        if (entry.seq <= delivered) {
          return;
        }
        delivered = entry.seq;
      }
      channel.send(entry.message, entry.seq > 0 ? entry.seq : undefined);
      if (entry.message.type === "end") {
        channel.finish();
      }
    },
    restart() {
      delivered = 0;
      channel.reset();
    },
  };
}

export const Route = createFileRoute("/api/logs/$deploymentId")({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        const session = await auth.api.getSession({ headers: request.headers });
        if (!session) {
          return new Response("not authenticated", { status: 401 });
        }

        const { deploymentId } = params;
        if (!UUID.test(deploymentId)) {
          return new Response("invalid id", { status: 400 });
        }

        const deployment =
          (await db.query.deployments.findFirst({
            where: eq(deployments.id, deploymentId),
          })) ??
          (await db.query.stackDeployments.findFirst({
            where: eq(stackDeployments.id, deploymentId),
          })) ??
          (await db.query.databaseDeployments.findFirst({
            where: eq(databaseDeployments.id, deploymentId),
          }));
        if (!deployment) {
          return new Response("deployment not found", { status: 404 });
        }

        const resume = parseLastEventId(request.headers.get("last-event-id"));

        return sseChannel(request, async (channel) => {
          const { deliver, restart } = replayer(channel, resume ?? 0);
          const finished = isTerminalStatus(deployment.status);

          let flushed = false;
          const pending: LogEntry[] = [];
          const unsubscribe = finished
            ? undefined
            : await logHub.subscribe(deploymentId, (entry) => {
                if (flushed) {
                  deliver(entry);
                  return;
                }
                pending.push(entry);
              });

          const plan = planReplay(
            await logHub.backlog(deploymentId),
            resume,
            LOG_BUFFER_MAX_ENTRIES
          );

          if (finished && plan.reset) {
            channel.reset();
            channel.send({
              data: archiveChunk(await readArchive(deploymentId)),
              type: "chunk",
            });
            channel.send({ status: deployment.status, type: "end" });
            channel.finish();
            return unsubscribe;
          }

          if (plan.reset) {
            restart();
          }
          if (plan.truncated) {
            channel.send({ data: OMITTED_NOTICE, type: "chunk" });
          }
          for (const entry of plan.entries) {
            deliver(entry);
          }

          flushed = true;
          for (const entry of pending) {
            deliver(entry);
          }

          if (finished && !channel.closed) {
            channel.send({ status: deployment.status, type: "end" });
            channel.finish();
          }

          return unsubscribe;
        });
      },
    },
  },
});
