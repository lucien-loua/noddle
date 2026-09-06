import type { Readable } from "node:stream";

import { resolveDestination, uploadStream } from "@noddle/backup";
import { controlPlaneSettings, servers } from "@noddle/db/schema";
import { log } from "@noddle/shared/log";
import { disconnect, execStream, quoteArg } from "@noddle/ssh-executor";
import { eq } from "drizzle-orm";

import type { DeployContext } from "#runtime-context";

const POSTGRES_CONTAINER = "noddle-postgres-1";

const CONTROL_PLANE_FOLDER = "noddle-control-plane";

async function record(
  ctx: DeployContext,
  outcome: { bytes?: number; error?: string; key?: string }
): Promise<void> {
  const existing = await ctx.db.query.controlPlaneSettings.findFirst();
  const patch = {
    backupLastAt: new Date(),
    backupLastBytes: outcome.bytes ?? null,
    backupLastError: outcome.error ?? null,
    backupLastKey: outcome.key ?? null,
  };
  if (existing) {
    await ctx.db
      .update(controlPlaneSettings)
      .set(patch)
      .where(eq(controlPlaneSettings.id, existing.id));
    return;
  }
  await ctx.db.insert(controlPlaneSettings).values(patch);
}

function credentials(): { database: string; user: string } {
  const raw = process.env.DATABASE_URL ?? "";
  try {
    const url = new URL(raw);
    return {
      database: url.pathname.replace(/^\//, "") || "noddle",
      user: decodeURIComponent(url.username) || "noddle",
    };
  } catch {
    return { database: "noddle", user: "noddle" };
  }
}

export async function backupControlPlane(
  ctx: DeployContext
): Promise<{ bytes: number; key: string } | null> {
  const settings = await ctx.db.query.controlPlaneSettings.findFirst();

  let destination: Awaited<
    ReturnType<typeof resolveDestination>
  >["destination"];
  try {
    ({ destination } = await resolveDestination(
      ctx.db,
      ctx.appKey,
      settings?.backupDestinationId
    ));
  } catch {
    await record(ctx, {
      error:
        "no S3 destination — add one under S3 destinations, then choose it here",
    });
    return null;
  }

  const self = await ctx.db.query.servers.findFirst({
    where: eq(servers.isSelf, true),
  });
  if (!self) {
    log.write("control-plane.backup.skipped", { why: "no self host" });
    return null;
  }

  const { database, user } = credentials();
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const key = [destination.prefix, CONTROL_PLANE_FOLDER, `${stamp}.dump`]
    .filter((part) => part !== "")
    .join("/");
  const command = [
    "sudo",
    "docker",
    "exec",
    POSTGRES_CONTAINER,
    "pg_dump",
    "-Fc",
    "-U",
    quoteArg(user),
    quoteArg(database),
  ].join(" ");

  const client = await ctx.connectTo(self);
  const startedAt = Date.now();
  try {
    const result = await execStream(client, command, (io) =>
      uploadStream(destination, key, io.stdout as Readable)
    );
    if (result.code !== 0) {
      throw new Error(
        `pg_dump exited ${result.code}: ${result.stderr.trim().slice(-400)}`
      );
    }
    log.write("control-plane.backup", {
      bytes: result.value,
      key,
      ms: Date.now() - startedAt,
    });
    await record(ctx, { bytes: result.value, key });
    return { bytes: result.value, key };
  } catch (error) {
    log.error("control-plane.backup.failed", error, {
      key,
      ms: Date.now() - startedAt,
    });
    await record(ctx, {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    disconnect(client);
  }
}
