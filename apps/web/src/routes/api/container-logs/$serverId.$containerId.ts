import { servers } from "@noddle/db/schema";
import { createFileRoute } from "@tanstack/react-router";
import { eq } from "drizzle-orm";

import { auth } from "@/lib/auth.server";
import {
  followContainerById,
  parseSince,
  parseTail,
  RESOURCE_UUID,
  sendLogError,
} from "@/lib/container-logs.server";
import { CONTAINER_ID } from "@/lib/container-read.server";
import { db } from "@/lib/db.server";
import { sseChannel } from "@/lib/sse-channel.server";
import { connectToServer } from "@/lib/ssh.server";

/**
 * Logs of ANY container on a machine, Noddle's own included.
 *
 * The service and database streams next door start from a row Noddle owns
 * and resolve the container behind it. This one starts from the container
 * — it is the only way to read something Noddle did not deploy, which is
 * the whole reason the Containers page shows those rows at all.
 *
 * Session only, like the two others: reading output is what `viewer` is
 * for, and the destructive actions on the same row are guarded elsewhere.
 */
export const Route = createFileRoute(
  "/api/container-logs/$serverId/$containerId"
)({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        const session = await auth.api.getSession({ headers: request.headers });
        if (!session) {
          return new Response("not authenticated", { status: 401 });
        }

        const { containerId, serverId } = params;
        if (!(RESOURCE_UUID.test(serverId) && CONTAINER_ID.test(containerId))) {
          return new Response("invalid id", { status: 400 });
        }

        const url = new URL(request.url);
        const tail = parseTail(url.searchParams.get("tail"));
        const since = parseSince(url.searchParams.get("since"));

        const server = await db.query.servers.findFirst({
          where: eq(servers.id, serverId),
        });
        if (!server) {
          return new Response("server not found", { status: 404 });
        }

        return sseChannel(request, async (channel) => {
          const { finish, send } = channel;
          let client: Awaited<ReturnType<typeof connectToServer>> | undefined;

          try {
            client = await connectToServer(server);
            return followContainerById(
              channel,
              client,
              containerId,
              tail,
              since
            );
          } catch (error) {
            sendLogError(send, error);
            client?.end();
            finish();
          }
        });
      },
    },
  },
});
