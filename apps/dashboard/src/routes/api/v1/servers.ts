import { servers } from "@noddle/db/schema";
import { createFileRoute } from "@tanstack/react-router";
import { desc } from "drizzle-orm";

import { withToken } from "@/lib/api-v1.server";
import { db } from "@/lib/db.server";

export const Route = createFileRoute("/api/v1/servers")({
  server: {
    handlers: {
      GET: ({ request }) =>
        withToken(request, { action: "read", resource: "server" }, async () => {
          const rows = await db
            .select({
              host: servers.host,
              id: servers.id,
              isSelf: servers.isSelf,
              name: servers.name,
              status: servers.status,
            })
            .from(servers)
            .orderBy(desc(servers.isSelf));
          return { servers: rows };
        }),
    },
  },
});
