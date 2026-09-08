import { services } from "@noddle/db/schema";
import { createFileRoute } from "@tanstack/react-router";
import { eq, or } from "drizzle-orm";

import { ApiClientError } from "@/lib/api-errors";
import { withToken } from "@/lib/api-v1.server";
import { db } from "@/lib/db.server";
import { queueServiceDeploy } from "@/lib/deploy-queue.server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function resolveService(wanted: string) {
  const matches = await db
    .select({ id: services.id, name: services.name })
    .from(services)
    .where(
      UUID.test(wanted)
        ? or(eq(services.id, wanted), eq(services.name, wanted))
        : eq(services.name, wanted)
    );

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
          async () => {
            const service = await resolveService(params.id);
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
