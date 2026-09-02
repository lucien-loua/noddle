import { servers } from "@noddle/db/schema";
import { createFileRoute } from "@tanstack/react-router";
import { eq } from "drizzle-orm";

import { auth } from "@/lib/auth.server";
import {
  containerLogStream,
  followContainerById,
  parseSince,
  parseTail,
  RESOURCE_UUID,
} from "@/lib/container-logs.server";
import { CONTAINER_ID } from "@/lib/container-read.server";
import { db } from "@/lib/db.server";

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

        return containerLogStream(request, server, (channel, client) =>
          followContainerById(channel, client, containerId, tail, since)
        );
      },
    },
  },
});
