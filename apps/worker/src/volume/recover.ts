import { volumeBackups } from "@noddle/db/schema";
import { eq, inArray } from "drizzle-orm";
import type { DeployContext } from "#runtime-context";

const STALE_MESSAGE =
  "interrupted — worker restarted while backup was in progress";

/** Marks orphaned `running` rows failed so the queue can move on after a crash. */
export async function recoverStaleVolumeBackups(
  ctx: DeployContext
): Promise<number> {
  const running = await ctx.db.query.volumeBackups.findMany({
    where: eq(volumeBackups.status, "running"),
  });
  if (running.length === 0) {
    return 0;
  }

  await ctx.db
    .update(volumeBackups)
    .set({
      errorMessage: STALE_MESSAGE,
      finishedAt: new Date(),
      status: "failed",
    })
    .where(
      inArray(
        volumeBackups.id,
        running.map((row) => row.id)
      )
    );
  return running.length;
}
