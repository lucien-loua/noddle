import { services } from "@noddle/db/schema";
import { createFileRoute } from "@tanstack/react-router";
import { eq } from "drizzle-orm";

import { notFound } from "@/lib/api-errors";
import { withToken } from "@/lib/api-v1.server";
import { db } from "@/lib/db.server";
import { queueServiceDeploy } from "@/lib/deploy-queue.server";

export const Route = createFileRoute("/api/v1/services/$id/deploy")({
  server: {
    handlers: {
      POST: ({ params, request }) =>
        withToken(
          request,
          { action: "deploy", resource: "service" },
          async () => {
            const service = await db.query.services.findFirst({
              where: eq(services.id, params.id),
            });
            if (!service) {
              throw notFound("service");
            }
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
