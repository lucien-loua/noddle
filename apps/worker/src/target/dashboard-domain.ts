import { controlPlaneSettings, servers } from "@noddle/db/schema";
import { exec, quoteArg } from "@noddle/ssh-executor";
import { eq } from "drizzle-orm";

import type { DeployContext } from "#runtime-context";

const NODDLE_DIR = "/opt/noddle";

function applyScript(env: Record<string, string>, https: boolean): string {
  const file = `${NODDLE_DIR}/installer/.env`;
  const edits = Object.entries(env)
    .map(
      ([key, value]) =>
        `sudo sed -i ${quoteArg(`/^${key}=/d`)} ${quoteArg(file)}; ` +
        `printf '%s\\n' ${quoteArg(`${key}=${value}`)} | sudo tee -a ${quoteArg(file)} >/dev/null`
    )
    .join("; ");

  const files = https
    ? "-f docker-compose.yml -f docker-compose.tls.yml"
    : "-f docker-compose.yml";

  return [
    "set -euo pipefail",
    `test -f ${quoteArg(file)}`,
    edits,
    `cd ${quoteArg(`${NODDLE_DIR}/installer`)}`,
    `sudo docker compose --env-file .env ${files} up -d`,
  ].join(" && ");
}

export async function configureDashboardDomain(
  ctx: DeployContext
): Promise<void> {
  const settings = await ctx.db.query.controlPlaneSettings.findFirst();
  if (!settings) {
    throw new Error("no control plane settings recorded");
  }

  const host = await ctx.db.query.servers.findFirst({
    where: eq(servers.isSelf, true),
  });
  if (!host) {
    throw new Error(
      "this Noddle was not installed by install.sh, so it does not manage its own host"
    );
  }

  const https = settings.httpsEnabled && Boolean(settings.domain);
  if (https && !settings.acmeEmail) {
    throw new Error("Let's Encrypt needs a contact address");
  }

  const domain = settings.domain ?? "";
  const url = domain ? `${https ? "https" : "http"}://${domain}` : "";

  try {
    const client = await ctx.connectTo(host);
    try {
      const result = await exec(
        client,
        applyScript(
          {
            ACME_EMAIL: settings.acmeEmail ?? "",
            NODDLE_DOMAIN: domain,
            NODDLE_URL: url,
          },
          https
        )
      );
      if (result.code !== 0) {
        throw new Error(result.stderr.trim() || `exited ${result.code}`);
      }
    } finally {
      client.end();
    }

    await ctx.db
      .update(controlPlaneSettings)
      .set({ lastError: null, status: "idle", updatedAt: new Date() })
      .where(eq(controlPlaneSettings.id, settings.id));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.db
      .update(controlPlaneSettings)
      .set({ lastError: message, status: "failed", updatedAt: new Date() })
      .where(eq(controlPlaneSettings.id, settings.id));
    throw error;
  }
}

export async function reloadControlPlane(ctx: DeployContext): Promise<void> {
  const host = await ctx.db.query.servers.findFirst({
    where: eq(servers.isSelf, true),
  });
  if (!host) {
    throw new Error(
      "this Noddle was not installed by install.sh, so it does not manage its own host"
    );
  }

  const settings = await ctx.db.query.controlPlaneSettings.findFirst();
  const files =
    settings?.httpsEnabled && settings.domain
      ? "-f docker-compose.yml -f docker-compose.tls.yml"
      : "-f docker-compose.yml";

  const client = await ctx.connectTo(host);
  try {
    const result = await exec(
      client,
      [
        "set -euo pipefail",
        `cd ${quoteArg(`${NODDLE_DIR}/installer`)}`,
        `sudo docker compose --env-file .env ${files} restart`,
      ].join(" && ")
    );
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || `exited ${result.code}`);
    }
  } finally {
    client.end();
  }
}
