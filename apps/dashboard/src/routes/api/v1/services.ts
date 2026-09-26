import { createFileRoute } from "@tanstack/react-router";

import { withToken } from "@/lib/api-v1.server";
import { db } from "@/lib/db.server";
import { listServiceSummaries } from "@/lib/team-queries.server";

export const Route = createFileRoute("/api/v1/services")({
  server: {
    handlers: {
      GET: ({ request }) =>
        withToken(
          request,
          { action: "read", resource: "service" },
          async (actor) => ({
            services: await listServiceSummaries(db, actor.team.id),
          })
        ),
    },
  },
});
