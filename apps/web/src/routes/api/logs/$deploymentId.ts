import { deployments, stackDeployments } from "@noddle/db/schema";
import { isTerminalStatus, type LogMessage } from "@noddle/shared/logs";
import { createFileRoute } from "@tanstack/react-router";
import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth.server";
import { db } from "@/lib/db.server";
import { readArchive } from "@/lib/log-archive.server";
import { logHub } from "@/lib/redis.server";

/** Proxies cut an idle connection. A build can stay silent for several
 *  minutes during a slow step. */
const HEARTBEAT_MS = 25_000;

const UUID = /^[0-9a-f-]{36}$/i;

export const Route = createFileRoute("/api/logs/$deploymentId")({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        // Build logs contain repo URLs and commit messages. This stream is
        // guarded like the rest.
        const session = await auth.api.getSession({ headers: request.headers });
        if (!session) {
          return new Response("not authenticated", { status: 401 });
        }

        const { deploymentId } = params;
        if (!UUID.test(deploymentId)) {
          return new Response("invalid id", { status: 400 });
        }

        // A service or a stack — same SSE stream, same generic key on the
        // Redis side (set by the worker under this same id in both cases).
        // We look on the service side first, the common case.
        const deployment =
          (await db.query.deployments.findFirst({
            where: eq(deployments.id, deploymentId),
          })) ??
          (await db.query.stackDeployments.findFirst({
            where: eq(stackDeployments.id, deploymentId),
          }));
        if (!deployment) {
          return new Response("deployment not found", { status: 404 });
        }

        const encoder = new TextEncoder();

        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            let closed = false;
            let heartbeat: ReturnType<typeof setInterval> | undefined;
            let unsubscribe: (() => void) | undefined;

            const finish = () => {
              if (closed) {
                return;
              }
              closed = true;
              if (heartbeat) {
                clearInterval(heartbeat);
              }
              unsubscribe?.();
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

            // The client left: close the Redis subscription right away,
            // otherwise every closed tab leaves a listener behind.
            request.signal.addEventListener("abort", finish);

            // 1. Finished: the archive is enough, there will be nothing more live.
            if (isTerminalStatus(deployment.status)) {
              const archive = await readArchive(deploymentId);
              send({
                data: archive ?? "(no logs kept for this deployment)\n",
                type: "chunk",
              });
              send({ status: deployment.status, type: "end" });
              finish();
              return;
            }

            // 3 before 2: we subscribe BEFORE reading the catch-up buffer.
            //
            // There's necessarily a window between the two, and we have to
            // choose what it produces. In this order, a line published
            // during the window is seen TWICE — once by the subscription,
            // once by the buffer. In the other order, it's LOST: too late
            // for the buffer already read, too early for the subscription
            // not yet active.
            //
            // A duplicate line is cosmetic; a line lost from the output of a
            // failed build is precisely what we were trying to read.
            // Deduplicating properly would need a sequence number per line,
            // hence one more Redis command per chunk — not worth it for a
            // rare few-millisecond duplicate.
            unsubscribe = await logHub.subscribe(deploymentId, (message) => {
              send(message);
              if (message.type === "end") {
                finish();
              }
            });

            for (const message of await logHub.backlog(deploymentId)) {
              send(message);
            }

            heartbeat = setInterval(() => {
              if (closed) {
                return;
              }
              try {
                // An SSE comment: ignored by EventSource, enough to keep the
                // connection alive.
                controller.enqueue(encoder.encode(": ping\n\n"));
              } catch {
                finish();
              }
            }, HEARTBEAT_MS);
          },
        });

        return new Response(stream, {
          headers: {
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "Content-Type": "text/event-stream",
            // Without this, an nginx in front buffers the stream and live
            // output arrives in multi-kilobyte chunks.
            "X-Accel-Buffering": "no",
          },
        });
      },
    },
  },
});
