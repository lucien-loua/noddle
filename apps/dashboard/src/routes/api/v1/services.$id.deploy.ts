import { createFileRoute } from "@tanstack/react-router";

import { ApiClientError } from "@/lib/api-errors";
import { withToken } from "@/lib/api-v1.server";
import { db } from "@/lib/db.server";
import { queueServiceDeploy } from "@/lib/deploy-queue.server";
import { servicesNamed } from "@/lib/team-queries.server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function resolveService(teamId: string, wanted: string) {
  const matches = await servicesNamed(db, teamId, wanted, UUID.test(wanted));

  const [only] = matches;
  if (matches.length === 1 && only) {
    return only;
  }
  if (matches.length === 0) {
    throw new ApiClientError(
      404,
      "not_found",
      `No service is named "${wanted}", and none has that id.`
    );
  }
  throw new ApiClientError(
    409,
    "ambiguous",
    `"${wanted}" names ${matches.length} services in different environments. Deploy by id: ${matches.map((s) => s.id).join(", ")}`
  );
}

export const Route = createFileRoute("/api/v1/services/$id/deploy")({
  server: {
    handlers: {
      POST: ({ params, request }) =>
        withToken(
          request,
          { action: "deploy", resource: "service" },
          async (actor) => {
            const service = await resolveService(actor.team.id, params.id);
            const { deploymentId } = await queueServiceDeploy(service.id, {
              trigger: "manual",
            });
            return {
              deploymentId,
              service: { id: service.id, name: service.name },
              status: "queued",
            };
          }
        ),
    },
  },
});
