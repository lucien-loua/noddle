import { deployments, services } from "@noddle/db/schema";
import {
  deployRequestSchema,
  lifecycleRequestSchema,
  rollbackRequestSchema,
} from "@noddle/shared/validation/service";
import { createServerFn } from "@tanstack/react-start";
import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db.server";
import { queueServiceDeploy } from "@/lib/deploy-queue.server";
import { runGuarded } from "@/lib/permission.server";
import { enqueueDeploy } from "@/lib/queue.server";

export const triggerDeploy = createServerFn({ method: "POST" })
  .validator(deployRequestSchema)
  .handler(async ({ data }): Promise<{ deploymentId: string }> =>
    runGuarded({
      load: () =>
        db.query.services.findFirst({
          where: eq(services.id, data.serviceId),
        }),
      notFoundMessage: "service not found",
      permission: { action: "deploy", resource: "service" },
      // The row is created HERE, not in the worker: the button must
      // return an id right away so the screen can subscribe to the log
      // stream before the build even starts. Same path as the webhook,
      // which queues the same kind of row without going through a
      // session.
      run: ({ row }) =>
        queueServiceDeploy(row.id, {
          commitSha: data.commitSha,
          trigger: "manual",
        }),
      target: ({ row }) => ({ id: row.id, name: row.name }),
    })
  );

/**
 * Stop, restart.
 *
 * Guarded by `service:deploy` and not by a new permission. The model is
 * split BY CONSEQUENCE: `deploy` and `delete` don't sit together because
 * deploying can be undone and deleting cannot. Stopping can be undone by
 * restarting, exactly like a failed deployment can be undone by a rollback —
 * so it's the same trust tier, and inventing `service:stop` would have added
 * a notch without adding any consequence.
 *
 * The job is queued, never executed here: it's the worker that talks to
 * Swarm.
 */
export const triggerLifecycle = createServerFn({ method: "POST" })
  .validator(lifecycleRequestSchema)
  .handler(async ({ data }): Promise<{ queued: true }> =>
    runGuarded({
      load: () =>
        db.query.services.findFirst({
          where: eq(services.id, data.serviceId),
        }),
      notFoundMessage: "service not found",
      permission: { action: "deploy", resource: "service" },
      run: async ({ row }) => {
        await enqueueDeploy({
          action: data.action,
          kind: "lifecycle",
          serviceId: row.id,
        });
        return { queued: true as const };
      },
      target: ({ row }) => ({ id: row.id, name: row.name }),
    })
  );

export const triggerRollback = createServerFn({ method: "POST" })
  .validator(rollbackRequestSchema)
  .handler(async ({ data }): Promise<{ imageTag: string }> =>
    // The audit object is the Service being rolled back, not the
    // deployment row the caller named.
    runGuarded({
      load: () =>
        db.query.services.findFirst({
          where: eq(services.id, data.serviceId),
        }),
      notFoundMessage: "service not found",
      permission: { action: "rollback", resource: "service" },
      run: async () => {
        // The target is re-read from the database rather than trusted as given:
        // the client sends a deployment id, not an image tag. Without this
        // read, a forged call could deploy any image present on the host.
        const target = await db.query.deployments.findFirst({
          where: and(
            eq(deployments.id, data.deploymentId),
            eq(deployments.serviceId, data.serviceId)
          ),
        });
        if (!target) {
          throw new Error("deployment not found for this service");
        }
        if (!target.imageTag) {
          throw new Error(
            "this deployment produced no image, so there is nothing to redeploy"
          );
        }

        // No build: the image already exists on the server. That's what makes
        // the rollback immediate, and possible to ANY version in history —
        // Swarm itself only keeps one previous spec.
        await enqueueDeploy({
          imageTag: target.imageTag,
          kind: "rollback",
          serviceId: data.serviceId,
        });
        return { imageTag: target.imageTag };
      },
      target: ({ row }) => ({ id: row.id, name: row.name }),
    })
  );
