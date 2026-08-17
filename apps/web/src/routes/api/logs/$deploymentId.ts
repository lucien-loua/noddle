import { deployments, stackDeployments } from "@noddle/db/schema";
import { isTerminalStatus } from "@noddle/shared/logs";
import { createFileRoute } from "@tanstack/react-router";
import { eq } from "drizzle-orm";

import { auth } from "@/lib/auth.server";
import { db } from "@/lib/db.server";
import { readArchive } from "@/lib/log-archive.server";
import { logHub } from "@/lib/redis.server";
import { sseChannel } from "@/lib/sse-channel.server";

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

        return sseChannel(request, async ({ finish, send }) => {
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

          // Subscribe BEFORE reading the catch-up buffer — a duplicate line
          // is cosmetic; a lost line from a failed build is not.
          const unsubscribe = await logHub.subscribe(
            deploymentId,
            (message) => {
              send(message);
              if (message.type === "end") {
                finish();
              }
            }
          );

          for (const message of await logHub.backlog(deploymentId)) {
            send(message);
          }

          return unsubscribe;
        });
      },
    },
  },
});
