import { decryptSecret, secretContext } from "@noddle/crypto";
import { notificationChannels } from "@noddle/db/schema";
import { deliver, isFailure } from "@noddle/shared/notify";
import type { NotificationEvent } from "@noddle/shared/notify";
import { eq } from "drizzle-orm";

import type { DeployContext } from "#runtime-context";

export async function notify(
  ctx: DeployContext,
  event: NotificationEvent
): Promise<void> {
  try {
    const channels = await ctx.db.query.notificationChannels.findMany({
      where: eq(notificationChannels.enabled, true),
    });

    const concerned = channels.filter(
      (c) => isFailure(event.type) || c.notifySuccess
    );
    if (concerned.length === 0) {
      return;
    }

    await Promise.all(
      concerned.map(async (channel) => {
        const url = decryptSecret(
          channel.urlEncrypted,
          ctx.appKey,
          secretContext.notificationChannel(channel.id)
        );
        const result = await deliver({ kind: channel.kind, url }, event);

        await ctx.db
          .update(notificationChannels)
          .set(
            result.ok
              ? { lastError: null, lastSuccessAt: new Date() }
              : { lastError: result.error ?? "unknown failure" }
          )
          .where(eq(notificationChannels.id, channel.id));
      })
    );
  } catch (error) {
    process.stderr.write(
      `notification not sent: ${error instanceof Error ? error.message : String(error)}\n`
    );
  }
}
