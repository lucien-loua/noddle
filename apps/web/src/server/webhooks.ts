import { randomBytes } from "node:crypto";
import { services, stacks } from "@noddle/db/schema";
import { encryptSecret, secretContext } from "@noddle/shared/crypto";
import { createServerFn } from "@tanstack/react-start";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db.server";
import { env } from "@/lib/env.server";
import { requirePermission } from "@/lib/permission.server";
import { requireSession } from "@/lib/session.server";

const SECRET_BYTES = 32;

function newSecret(): string {
  return randomBytes(SECRET_BYTES).toString("hex");
}

export interface WebhookStatus {
  configured: boolean;
  path: string;
}

const serviceIdSchema = z.object({ serviceId: z.uuid() });
const stackIdSchema = z.object({ stackId: z.uuid() });

export const getServiceWebhook = createServerFn({ method: "GET" })
  .validator(serviceIdSchema)
  .handler(async ({ data }): Promise<WebhookStatus> => {
    await requireSession();
    const service = await db.query.services.findFirst({
      where: eq(services.id, data.serviceId),
    });
    return {
      configured: Boolean(service?.webhookSecretEncrypted),
      path: `/api/webhooks/service/${data.serviceId}`,
    };
  });

export const generateServiceWebhook = createServerFn({ method: "POST" })
  .validator(serviceIdSchema)
  .handler(async ({ data }): Promise<{ path: string; secret: string }> => {
    await requirePermission({ action: "create", resource: "service" });
    const secret = newSecret();
    await db
      .update(services)
      .set({
        webhookSecretEncrypted: encryptSecret(
          secret,
          env.appKey,
          secretContext.webhookSecret(data.serviceId)
        ),
      })
      .where(eq(services.id, data.serviceId));
    return { path: `/api/webhooks/service/${data.serviceId}`, secret };
  });

export const getStackWebhook = createServerFn({ method: "GET" })
  .validator(stackIdSchema)
  .handler(async ({ data }): Promise<WebhookStatus> => {
    await requireSession();
    const stack = await db.query.stacks.findFirst({
      where: eq(stacks.id, data.stackId),
    });
    return {
      configured: Boolean(stack?.webhookSecretEncrypted),
      path: `/api/webhooks/stack/${data.stackId}`,
    };
  });

export const generateStackWebhook = createServerFn({ method: "POST" })
  .validator(stackIdSchema)
  .handler(async ({ data }): Promise<{ path: string; secret: string }> => {
    await requirePermission({ action: "create", resource: "service" });
    const secret = newSecret();
    await db
      .update(stacks)
      .set({
        webhookSecretEncrypted: encryptSecret(
          secret,
          env.appKey,
          secretContext.webhookSecret(data.stackId)
        ),
      })
      .where(eq(stacks.id, data.stackId));
    return { path: `/api/webhooks/stack/${data.stackId}`, secret };
  });
