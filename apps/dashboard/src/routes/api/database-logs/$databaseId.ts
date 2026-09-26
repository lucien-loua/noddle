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
import { databaseInContext } from "@/lib/team-queries.server";
import { teamOfSession } from "@/lib/team-scope.server";

export const Route = createFileRoute("/api/database-logs/$databaseId")({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        const session = await auth.api.getSession({ headers: request.headers });
        if (!session) {
          return new Response("not authenticated", { status: 401 });
        }

        const { databaseId } = params;
        if (!RESOURCE_UUID.test(databaseId)) {
          return new Response("invalid id", { status: 400 });
        }

        const url = new URL(request.url);
        const tail = parseTail(url.searchParams.get("tail"));
        const since = parseSince(url.searchParams.get("since"));

        const database = await databaseInContext(
          db,
          await teamOfSession(session),
          databaseId
        );
        if (!database) {
          return new Response("database not found", { status: 404 });
        }

        return containerLogStream(request, database.server, (channel, client) =>
          followContainerLogs(channel, client, database.swarmName, tail, since)
        );
      },
    },
  },
});
