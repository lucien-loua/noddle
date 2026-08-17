import { decryptSecret, secretContext } from "@noddle/crypto";
import { notificationChannels } from "@noddle/db/schema";
import { deliver, isFailure } from "@noddle/notifier";
import type { NotificationEvent } from "@noddle/notifier";
import { eq } from "drizzle-orm";

import type { DeployContext } from "#runtime-context";

/**
 * Sends an event to all concerned channels.
 *
 * Doesn't throw, doesn't return anything actionable: the caller has nothing
 * to decide based on this. The result of each send is written on the
 * channel, because that's where it will be read — a send that fails
 * silently is worse than no notification at all, since you'd believe you're
 * being watched.
 */
export async function notify(ctx: DeployContext, event: NotificationEvent): Promise<void> {
  try {
    const channels = await ctx.db.query.notificationChannels.findMany({
      where: eq(notificationChannels.enabled, true),
    });

    const concerned = channels.filter((c) => isFailure(event.type) || c.notifySuccess);
    if (concerned.length === 0) {
      return;
    }

    // In parallel: a slow channel must not delay the others, and each
    // already carries its own timeout.
    await Promise.all(
      concerned.map(async (channel) => {
        const url = decryptSecret(
          channel.urlEncrypted,
          ctx.appKey,
          secretContext.notificationChannel(channel.id),
        );
        const result = await deliver({ kind: channel.kind, url }, event);

        await ctx.db
          .update(notificationChannels)
          .set(
            result.ok
              ? { lastError: null, lastSuccessAt: new Date() }
              : { lastError: result.error ?? "unknown failure" },
          )
          .where(eq(notificationChannels.id, channel.id));
      }),
    );
  } catch (error) {
    // Including an unreachable database or a decryption failure. Nothing
    // that happens here is allowed to propagate up to the job.
    process.stderr.write(
      `notification not sent: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}
