import { createFileRoute } from "@tanstack/react-router";

import { notFound } from "@/lib/api-errors";
import { withToken } from "@/lib/api-v1.server";
import { db } from "@/lib/db.server";
import { serviceDeploymentById } from "@/lib/team-queries.server";

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
          async (actor) => {
            const row = await serviceDeploymentById(
              db,
              actor.team.id,
              params.id
            );
            if (!row) {
              throw notFound("deployment");
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
