import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  downloadStream,
  listObjects,
  resolveDestination,
  uploadStream,
} from "@noddle/backup";
import { controlPlaneSettings, servers } from "@noddle/db/schema";
import { log } from "@noddle/shared/log";
import {
  disconnect,
  execArgv,
  execStream,
  quoteArg,
} from "@noddle/ssh-executor";
import { eq } from "drizzle-orm";

import type { DeployContext } from "#runtime-context";

const NOT_AN_INSTALL = new Set(["127.0.0.1", "::1", "localhost"]);

async function postgresContainer(
  client: Awaited<ReturnType<DeployContext["connectTo"]>>,
  service: string
): Promise<string> {
  const found = await execArgv(client, [
    "sudo",
    "docker",
    "ps",
    "--filter",
    `label=com.docker.compose.service=${service}`,
    "--format",
    "{{.Names}}",
  ]);
  const names = found.stdout.trim().split("\n").filter(Boolean);

  if (names.length === 1 && names[0]) {
    return names[0];
  }
  if (names.length === 0) {
    throw new Error(
      `no container runs the compose service "${service}" on this host. The control-plane backup dumps the installed stack, so it has nothing to dump here.`
    );
  }
  throw new Error(
    `several containers claim the compose service "${service}" (${names.join(", ")}), so which one holds the control plane is ambiguous.`
  );
}

const CONTROL_PLANE_FOLDER = "noddle-control-plane";

const NODDLE_ETC = "/etc/noddle";
const ENV_FILE = "/opt/noddle/installer/.env";

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

function credentials(): { database: string; host: string; user: string } {
  const raw = process.env.DATABASE_URL ?? "";
  try {
    const url = new URL(raw);
    return {
      database: url.pathname.replace(/^\//, "") || "noddle",
      host: url.hostname || "postgres",
      user: decodeURIComponent(url.username) || "noddle",
    };
  } catch {
    return { database: "noddle", host: "postgres", user: "noddle" };
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

  const { database, host, user } = credentials();
  if (NOT_AN_INSTALL.has(host)) {
    await record(ctx, {
      error:
        "this process talks to a local database, not an installed control plane, so there is nothing to back up",
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

  const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const key = [destination.prefix, CONTROL_PLANE_FOLDER, `${stamp}.tar`]
    .filter((part) => part !== "")
    .join("/");
  const client = await ctx.connectTo(self);
  const startedAt = Date.now();
  try {
    const container = await postgresContainer(client, host);
    const dump = [
      "docker",
      "exec",
      container,
      "pg_dump",
      "-Fc",
      "-U",
      quoteArg(user),
      quoteArg(database),
    ].join(" ");

    const script = [
      "set -e",
      "d=$(mktemp -d)",
      'trap "rm -rf $d" EXIT',
      `${dump} > $d/database.dump`,
      `cp -a ${NODDLE_ETC} $d/etc-noddle`,
      `cp ${ENV_FILE} $d/env`,
      'tar -cf - -C "$d" database.dump etc-noddle env',
    ].join("; ");

    const command = `sudo sh -c ${quoteArg(script)}`;

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

export async function listControlPlaneBackups(
  ctx: DeployContext
): Promise<{ key: string; size: number; takenAt: string }[]> {
  const settings = await ctx.db.query.controlPlaneSettings.findFirst();
  const { destination } = await resolveDestination(
    ctx.db,
    ctx.appKey,
    settings?.backupDestinationId
  );
  const objects = await listObjects(destination, {
    prefix: CONTROL_PLANE_FOLDER,
  });
  return objects
    .map((object) => ({
      key: object.key,
      size: object.sizeBytes,
      takenAt: object.lastModified ?? "",
    }))
    .toSorted((a, b) => b.takenAt.localeCompare(a.takenAt));
}

export async function restoreControlPlane(
  ctx: DeployContext,
  key: string
): Promise<void> {
  const settings = await ctx.db.query.controlPlaneSettings.findFirst();
  const { destination } = await resolveDestination(
    ctx.db,
    ctx.appKey,
    settings?.backupDestinationId
  );

  const { database, host, user } = credentials();
  if (NOT_AN_INSTALL.has(host)) {
    throw new Error(
      "this process talks to a local database, not an installed control plane"
    );
  }

  const self = await ctx.db.query.servers.findFirst({
    where: eq(servers.isSelf, true),
  });
  if (!self) {
    throw new Error(
      "no self host is registered, so there is nothing to restore onto"
    );
  }

  const client = await ctx.connectTo(self);
  const startedAt = Date.now();
  try {
    const container = await postgresContainer(client, host);
    const body = await downloadStream(destination, key);

    const restore = [
      "docker",
      "exec",
      "-i",
      container,
      "pg_restore",
      "--clean",
      "--if-exists",
      "--single-transaction",
      "--exit-on-error",
      "-U",
      quoteArg(user),
      "-d",
      quoteArg(database),
    ].join(" ");

    const script = [
      "set -e",
      "d=$(mktemp -d)",
      'trap "rm -rf $d" EXIT',
      'tar -xf - -C "$d"',
      `${restore} < $d/database.dump`,
      `rm -rf ${NODDLE_ETC}`,
      `cp -a $d/etc-noddle ${NODDLE_ETC}`,
      `for k in APP_KEY REGISTRY_PASSWORD; do v=$(grep "^$k=" $d/env | cut -d= -f2-); if [ -n "$v" ]; then sed -i "/^$k=/d" ${ENV_FILE}; printf "%s=%s\\n" "$k" "$v" >> ${ENV_FILE}; fi; done`,
    ].join("; ");

    const result = await execStream(
      client,
      `sudo sh -c ${quoteArg(script)}`,
      async (io) => {
        io.stdout.resume();
        await pipeline(body, io.stdin);
      }
    );
    if (result.code !== 0) {
      throw new Error(
        `restore failed (${result.code}): ${result.stderr.trim().slice(-400)}`
      );
    }

    await execArgv(client, [
      "sudo",
      "sh",
      "-c",
      `setsid nohup docker compose --project-directory /opt/noddle/installer --env-file ${ENV_FILE} -f /opt/noddle/installer/docker-compose.yml up -d --force-recreate dashboard worker > /var/log/noddle-restore.log 2>&1 < /dev/null &`,
    ]);

    log.write("control-plane.restored", { key, ms: Date.now() - startedAt });
  } catch (error) {
    log.error("control-plane.restore.failed", error, {
      key,
      ms: Date.now() - startedAt,
    });
    throw error;
  } finally {
    disconnect(client);
  }
}
