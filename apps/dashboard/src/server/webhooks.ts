import { randomBytes } from "node:crypto";

import { encryptSecret, secretContext } from "@noddle/crypto";
import { services, stacks } from "@noddle/db/schema";
import { createServerFn } from "@tanstack/react-start";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db.server";
import { env } from "@/lib/env.server";
import { guarded } from "@/lib/guarded.server";
import { runGuarded } from "@/lib/permission.server";
import {
  serviceWebhookConfigured,
  stackWebhookConfigured,
} from "@/lib/team-queries.server";
import { activeTeamId } from "@/lib/team-scope.server";

const SECRET_BYTES = 32;

function newSecret(): string {
  return randomBytes(SECRET_BYTES).toString("hex");
}

export interface WebhookStatus {
  configured: boolean;
  path: string;
}

const serviceIdSchema = z.object({ serviceId: z.uuid("Choose a service.") });
const stackIdSchema = z.object({ stackId: z.uuid("Choose a stack.") });

export const getServiceWebhook = createServerFn({ method: "GET" })
  .validator(serviceIdSchema)
  .handler(async ({ data }): Promise<WebhookStatus> => ({
    configured: await serviceWebhookConfigured(
      db,
      await activeTeamId(),
      data.serviceId
    ),
    path: `/api/webhooks/service/${data.serviceId}`,
  }));

export const generateServiceWebhook = createServerFn({ method: "POST" })
  .validator(serviceIdSchema)
  .handler(async ({ data }): Promise<{ path: string; secret: string }> =>
    runGuarded({
      ...guarded.service(data.serviceId),
      permission: { action: "create", resource: "service" },
      run: async ({ row }) => {
        const secret = newSecret();
        await db
          .update(services)
          .set({
            webhookSecretEncrypted: encryptSecret(
              secret,
              env.appKey,
              secretContext.webhookSecret(row.id)
            ),
          })
          .where(eq(services.id, row.id));
        return { path: `/api/webhooks/service/${row.id}`, secret };
      },
      target: ({ row }) => ({ id: row.id, name: row.name }),
    })
  );

export const getStackWebhook = createServerFn({ method: "GET" })
  .validator(stackIdSchema)
  .handler(async ({ data }): Promise<WebhookStatus> => ({
    configured: await stackWebhookConfigured(
      db,
      await activeTeamId(),
      data.stackId
    ),
    path: `/api/webhooks/stack/${data.stackId}`,
  }));

export const generateStackWebhook = createServerFn({ method: "POST" })
  .validator(stackIdSchema)
  .handler(async ({ data }): Promise<{ path: string; secret: string }> =>
    runGuarded({
      ...guarded.stack(data.stackId),
      permission: { action: "create", resource: "service" },
      run: async ({ row }) => {
        const secret = newSecret();
        await db
          .update(stacks)
          .set({
            webhookSecretEncrypted: encryptSecret(
              secret,
              env.appKey,
              secretContext.webhookSecret(row.id)
            ),
          })
          .where(eq(stacks.id, row.id));
        return { path: `/api/webhooks/stack/${row.id}`, secret };
      },
      target: ({ row }) => ({ id: row.id, name: row.name }),
    })
  );
