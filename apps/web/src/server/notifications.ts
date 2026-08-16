import { decryptSecret, encryptSecret, secretContext } from "@noddle/crypto";
import { notificationChannels } from "@noddle/db/schema";
import { deliver } from "@noddle/notifier";
import {
  notificationChannelIdSchema,
  notificationChannelSchema,
  notificationChannelUpdateSchema,
} from "@noddle/shared/validation/notification";
import { createServerFn } from "@tanstack/react-start";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db.server";
import { env } from "@/lib/env.server";
import { runGuarded } from "@/lib/permission.server";
import { requireSession } from "@/lib/session.server";

/**
 * The channel as it comes back to the browser: WITHOUT its URL.
 *
 * It never comes out, not even encrypted — a Discord or Slack webhook URL
 * is a bearer secret, whoever holds it can post in the channel. Same rule
 * as the S3 secret key and a database's password.
 */
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
    const guarded = await runGuarded({
      permission: { action: "manage", resource: "notification" },
      run: async () => {
        // Encryption is bound to the row's id (AAD): insert then update, same
        // as a server SSH key or an S3 destination.
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
      // The channel, never its URL — a webhook URL is a secret.
      target: ({ result }) => ({ id: result.id, name: result.name }),
    });
    return { id: guarded.id };
  });

export const updateChannel = createServerFn({ method: "POST" })
  .validator(notificationChannelUpdateSchema)
  .handler(async ({ data }): Promise<{ saved: true }> =>
    runGuarded({
      load: () =>
        db.query.notificationChannels.findFirst({
          where: eq(notificationChannels.id, data.channelId),
        }),
      notFoundMessage: "channel not found",
      permission: { action: "manage", resource: "notification" },
      run: async ({ row: existing }) => {
        // Missing URL = "keep the previous one": the form can't redisplay it to
        // send it back, since it never comes out.
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
      target: ({ row }) => ({ id: row.id, name: row.name }),
    })
  );

export const deleteChannel = createServerFn({ method: "POST" })
  .validator(notificationChannelIdSchema)
  .handler(async ({ data }): Promise<{ deleted: true }> =>
    runGuarded({
      load: () =>
        db.query.notificationChannels.findFirst({
          where: eq(notificationChannels.id, data.channelId),
        }),
      notFoundMessage: "channel not found",
      permission: { action: "manage", resource: "notification" },
      run: async ({ row }) => {
        await db
          .delete(notificationChannels)
          .where(eq(notificationChannels.id, row.id));
        return { deleted: true as const };
      },
      target: ({ row }) => ({ id: row.id, name: row.name }),
    })
  );

/**
 * Sends a real test notification, and records the result.
 *
 * The result is written to the channel, not just returned: it's the same
 * column the worker feeds, so a successful test turns the indicator green
 * again exactly as a real event would. Two paths writing two different
 * states would eventually contradict each other on screen.
 */
export const testChannel = createServerFn({ method: "POST" })
  .validator(notificationChannelIdSchema)
  .handler(async ({ data }): Promise<{ error?: string; ok: boolean }> =>
    runGuarded({
      load: () =>
        db.query.notificationChannels.findFirst({
          where: eq(notificationChannels.id, data.channelId),
        }),
      notFoundMessage: "channel not found",
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
      target: ({ row }) => ({ id: row.id, name: row.name }),
    })
  );
