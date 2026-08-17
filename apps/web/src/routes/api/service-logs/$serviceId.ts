import { servers, services } from "@noddle/db/schema";
import { swarmServiceName } from "@noddle/shared/swarm-names";
import { createFileRoute } from "@tanstack/react-router";
import { eq } from "drizzle-orm";

import { auth } from "@/lib/auth.server";
import {
  followContainerLogs,
  parseSince,
  parseTail,
  RESOURCE_UUID,
  sendLogError,
} from "@/lib/container-logs.server";
import { db } from "@/lib/db.server";
import { sseChannel } from "@/lib/sse-channel.server";
import { connectToServer } from "@/lib/ssh.server";

export const Route = createFileRoute("/api/service-logs/$serviceId")({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        const session = await auth.api.getSession({ headers: request.headers });
        if (!session) {
          return new Response("not authenticated", { status: 401 });
        }

        const { serviceId } = params;
        if (!RESOURCE_UUID.test(serviceId)) {
          return new Response("invalid id", { status: 400 });
        }

        const url = new URL(request.url);
        const tail = parseTail(url.searchParams.get("tail"));
        const since = parseSince(url.searchParams.get("since"));

        const service = await db.query.services.findFirst({
          where: eq(services.id, serviceId),
        });
        if (!service) {
          return new Response("service not found", { status: 404 });
        }

        const server = await db.query.servers.findFirst({
          where: eq(servers.id, service.serverId),
        });
        if (!server) {
          return new Response("server not found", { status: 404 });
        }

        return sseChannel(request, async (channel) => {
          const { finish, send } = channel;
          let client: Awaited<ReturnType<typeof connectToServer>> | undefined;

          try {
            client = await connectToServer(server);
            return followContainerLogs(channel, client, swarmServiceName(service), tail, since);
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
