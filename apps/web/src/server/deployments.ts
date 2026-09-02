import { deployments } from "@noddle/db/schema";
import {
  deployRequestSchema,
  lifecycleRequestSchema,
  rollbackRequestSchema,
} from "@noddle/shared/validation/service";
import { createServerFn } from "@tanstack/react-start";
import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db.server";
import { queueServiceDeploy } from "@/lib/deploy-queue.server";
import { guarded, identityTarget } from "@/lib/guarded.server";
import { runGuarded } from "@/lib/permission.server";
import { enqueueDeploy } from "@/lib/queue.server";

export const triggerDeploy = createServerFn({ method: "POST" })
  .validator(deployRequestSchema)
  .handler(async ({ data }): Promise<{ deploymentId: string }> =>
    runGuarded({
      ...guarded.service(data.serviceId),
      permission: { action: "deploy", resource: "service" },
      run: ({ row }) =>
        queueServiceDeploy(row.id, {
          commitSha: data.commitSha,
          trigger: "manual",
        }),
      target: identityTarget,
    })
  );

export const triggerLifecycle = createServerFn({ method: "POST" })
  .validator(lifecycleRequestSchema)
  .handler(async ({ data }): Promise<{ queued: true }> =>
    runGuarded({
      ...guarded.service(data.serviceId),
      permission: { action: "deploy", resource: "service" },
      run: async ({ row }) => {
        await enqueueDeploy({
          action: data.action,
          kind: "lifecycle",
          serviceId: row.id,
        });
        return { queued: true as const };
      },
      target: identityTarget,
    })
  );

export const triggerRollback = createServerFn({ method: "POST" })
  .validator(rollbackRequestSchema)
  .handler(async ({ data }): Promise<{ imageTag: string }> =>
    runGuarded({
      ...guarded.service(data.serviceId),
      permission: { action: "rollback", resource: "service" },
      run: async () => {
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

        await enqueueDeploy({
          imageTag: target.imageTag,
          kind: "rollback",
          serviceId: data.serviceId,
        });
        return { imageTag: target.imageTag };
      },
      target: identityTarget,
    })
  );
