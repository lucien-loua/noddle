import { deployments } from "@noddle/db/schema";
import { createFileRoute } from "@tanstack/react-router";
import { eq } from "drizzle-orm";

import { withToken } from "@/lib/api-v1.server";
import { db } from "@/lib/db.server";

const TERMINAL = new Set([
  "succeeded",
  "failed",
  "rolled_back",
  "reverted_by_watch",
]);

export const Route = createFileRoute("/api/v1/deployments/$id")({
  server: {
    handlers: {
      GET: ({ params, request }) =>
        withToken(
          request,
          { action: "read", resource: "service" },
          async () => {
            const row = await db.query.deployments.findFirst({
              where: eq(deployments.id, params.id),
            });
            if (!row) {
              throw new Error("deployment not found");
            }
            return {
              commitSha: row.commitSha,
              done: TERMINAL.has(row.status),
              finishedAt: row.finishedAt?.toISOString() ?? null,
              id: row.id,
              imageTag: row.imageTag,
              serviceId: row.serviceId,
              startedAt: row.startedAt?.toISOString() ?? null,
              status: row.status,
              trigger: row.trigger,
            };
          }
        ),
    },
  },
});
