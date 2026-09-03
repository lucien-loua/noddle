import { decryptSecret, encryptSecret, secretContext } from "@noddle/crypto";
import { notificationChannels } from "@noddle/db/schema";
import { deliver } from "@noddle/shared/notify";
import {
  notificationChannelIdSchema,
  notificationChannelSchema,
  notificationChannelUpdateSchema,
} from "@noddle/shared/validation/notification";
import { createServerFn } from "@tanstack/react-start";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db.server";
import { env } from "@/lib/env.server";
import { guarded, identityTarget } from "@/lib/guarded.server";
import { runGuarded } from "@/lib/permission.server";
import { requireSession } from "@/lib/session.server";

export interface ChannelRow {
  enabled: boolean;
  id: string;
  kind: "discord" | "slack" | "webhook";
  lastError: string | null;
  lastSuccessAt: string | null;
  name: string;
  notifySuccess: boolean;
}

function toRow(c: typeof notificationChannels.$inferSelect): ChannelRow {
  return {
    enabled: c.enabled,
    id: c.id,
    kind: c.kind,
    lastError: c.lastError,
    lastSuccessAt: c.lastSuccessAt?.toISOString() ?? null,
    name: c.name,
    notifySuccess: c.notifySuccess,
  };
}

export const getChannels = createServerFn({ method: "GET" }).handler(
  async (): Promise<ChannelRow[]> => {
    await requireSession();
    const rows = await db.query.notificationChannels.findMany({
      orderBy: notificationChannels.createdAt,
    });
    return rows.map(toRow);
  }
);

export const addChannel = createServerFn({ method: "POST" })
  .validator(notificationChannelSchema)
  .handler(async ({ data }): Promise<{ id: string }> => {
    const outcome = await runGuarded({
      permission: { action: "manage", resource: "notification" },
      run: async () => {
        const [created] = await db
          .insert(notificationChannels)
          .values({
            kind: data.kind,
            name: data.name,
            notifySuccess: data.notifySuccess,
            urlEncrypted: "placeholder",
          })
          .returning();
        if (!created) {
          throw new Error("could not create channel");
        }
        await db
          .update(notificationChannels)
          .set({
            urlEncrypted: encryptSecret(
              data.url,
              env.appKey,
              secretContext.notificationChannel(created.id)
            ),
          })
          .where(eq(notificationChannels.id, created.id));
        return { id: created.id, name: created.name };
      },
      target: ({ result }) => ({ id: result.id, name: result.name }),
    });
    return { id: outcome.id };
  });

export const updateChannel = createServerFn({ method: "POST" })
  .validator(notificationChannelUpdateSchema)
  .handler(async ({ data }): Promise<{ saved: true }> =>
    runGuarded({
      ...guarded.notificationChannel(data.channelId),
      permission: { action: "manage", resource: "notification" },
      run: async ({ row: existing }) => {
        const urlEncrypted = data.url
          ? encryptSecret(
              data.url,
              env.appKey,
              secretContext.notificationChannel(existing.id)
            )
          : existing.urlEncrypted;

        await db
          .update(notificationChannels)
          .set({
            enabled: data.enabled,
            name: data.name,
            notifySuccess: data.notifySuccess,
            updatedAt: new Date(),
            urlEncrypted,
          })
          .where(eq(notificationChannels.id, existing.id));
        return { saved: true as const };
      },
      target: identityTarget,
    })
  );

export const deleteChannel = createServerFn({ method: "POST" })
  .validator(notificationChannelIdSchema)
  .handler(async ({ data }): Promise<{ deleted: true }> =>
    runGuarded({
      ...guarded.notificationChannel(data.channelId),
      permission: { action: "manage", resource: "notification" },
      run: async ({ row }) => {
        await db
          .delete(notificationChannels)
          .where(eq(notificationChannels.id, row.id));
        return { deleted: true as const };
      },
      target: identityTarget,
    })
  );

export const testChannel = createServerFn({ method: "POST" })
  .validator(notificationChannelIdSchema)
  .handler(async ({ data }): Promise<{ error?: string; ok: boolean }> =>
    runGuarded({
      ...guarded.notificationChannel(data.channelId),
      permission: { action: "manage", resource: "notification" },
      run: async ({ row: channel }) => {
        const url = decryptSecret(
          channel.urlEncrypted,
          env.appKey,
          secretContext.notificationChannel(channel.id)
        );
        const result = await deliver(
          { kind: channel.kind, url },
          {
            detail: "If you are reading this, the channel works.",
            resource: "test",
            type: "deploy_succeeded",
          }
        );

        await db
          .update(notificationChannels)
          .set(
            result.ok
              ? { lastError: null, lastSuccessAt: new Date() }
              : { lastError: result.error ?? "unknown failure" }
          )
          .where(eq(notificationChannels.id, channel.id));

        return { error: result.error, ok: result.ok };
      },
      target: identityTarget,
    })
  );
