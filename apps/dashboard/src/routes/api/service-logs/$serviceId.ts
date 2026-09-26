import { swarmServiceName } from "@noddle/shared/swarm-names";
import { createFileRoute } from "@tanstack/react-router";

import { auth } from "@/lib/auth.server";
import {
  containerLogStream,
  followContainerLogs,
  parseSince,
  parseTail,
  RESOURCE_UUID,
} from "@/lib/container-logs.server";
import { db } from "@/lib/db.server";
import { serviceInContext } from "@/lib/team-queries.server";
import { teamOfSession } from "@/lib/team-scope.server";

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

        const service = await serviceInContext(
          db,
          await teamOfSession(session),
          serviceId
        );
        if (!service) {
          return new Response("service not found", { status: 404 });
        }

        return containerLogStream(request, service.server, (channel, client) =>
          followContainerLogs(
            channel,
            client,
            swarmServiceName(service),
            tail,
            since
          )
        );
      },
    },
  },
});
