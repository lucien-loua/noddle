import { services } from "@noddle/db/schema";
import { createFileRoute } from "@tanstack/react-router";
import { asc } from "drizzle-orm";

import { withToken } from "@/lib/api-v1.server";
import { db } from "@/lib/db.server";

export const Route = createFileRoute("/api/v1/services")({
  server: {
    handlers: {
      GET: ({ request }) =>
        withToken(
          request,
          { action: "read", resource: "service" },
          async () => {
            const rows = await db
              .select({
                displayName: services.displayName,
                environmentId: services.environmentId,
                id: services.id,
                name: services.name,
                status: services.status,
              })
              .from(services)
              .orderBy(asc(services.name));
            return { services: rows };
          }
        ),
    },
  },
});
