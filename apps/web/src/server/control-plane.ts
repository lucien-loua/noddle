import { controlPlaneSettings, servers } from "@noddle/db/schema";
import { createServerFn } from "@tanstack/react-start";
import { eq } from "drizzle-orm";
import z from "zod";

import { db } from "@/lib/db.server";
import { requirePermission } from "@/lib/permission.server";
import { enqueueDeploy } from "@/lib/queue.server";
import { requireSession } from "@/lib/session.server";

const CONTROL_PLANE_PERMISSION = Object.freeze({
  action: "create",
  resource: "server",
});

const HOSTNAME = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/i;

export interface ControlPlaneSettings {
  acmeEmail: string | null;
  domain: string | null;
  httpsEnabled: boolean;
  lastError: string | null;
  managesItsHost: boolean;
  status: string;
}

const dashboardDomainSchema = z
  .object({
    acmeEmail: z.email().nullable(),
    domain: z.string().regex(HOSTNAME, "not a hostname").nullable(),
    httpsEnabled: z.boolean(),
  })
  .refine((v) => !v.httpsEnabled || Boolean(v.domain), {
    message: "HTTPS needs a domain",
    path: ["domain"],
  })
  .refine((v) => !v.httpsEnabled || Boolean(v.acmeEmail), {
    message: "Let's Encrypt needs a contact address",
    path: ["acmeEmail"],
  });

export const getControlPlaneSettings = createServerFn({
  method: "GET",
}).handler(async (): Promise<ControlPlaneSettings> => {
  await requireSession();
  const [row, host] = await Promise.all([
    db.query.controlPlaneSettings.findFirst(),
    db.query.servers.findFirst({ where: eq(servers.isSelf, true) }),
  ]);
  return {
    acmeEmail: row?.acmeEmail ?? null,
    domain: row?.domain ?? null,
    httpsEnabled: row?.httpsEnabled ?? false,
    lastError: row?.lastError ?? null,
    managesItsHost: Boolean(host),
    status: row?.status ?? "idle",
  };
});

export const saveDashboardDomain = createServerFn({ method: "POST" })
  .validator(dashboardDomainSchema)
  .handler(async ({ data }): Promise<{ queued: true }> => {
    await requirePermission(CONTROL_PLANE_PERMISSION);

    const host = await db.query.servers.findFirst({
      where: eq(servers.isSelf, true),
    });
    if (!host) {
      throw new Error(
        "This Noddle was not installed by install.sh, so it cannot reconfigure its own host."
      );
    }

    const existing = await db.query.controlPlaneSettings.findFirst();
    const values = {
      acmeEmail: data.acmeEmail,
      domain: data.domain,
      httpsEnabled: data.httpsEnabled,
      lastError: null,
      status: "applying" as const,
      updatedAt: new Date(),
    };

    if (existing) {
      await db
        .update(controlPlaneSettings)
        .set(values)
        .where(eq(controlPlaneSettings.id, existing.id));
    } else {
      await db.insert(controlPlaneSettings).values(values);
    }

    await enqueueDeploy({ kind: "configure-dashboard-domain" });
    return { queued: true };
  });

export const runMaintenance = createServerFn({ method: "POST" })
  .validator(z.object({ task: z.enum(["prune-docker", "prune-registry"]) }))
  .handler(async ({ data }): Promise<{ queued: true }> => {
    await requirePermission(CONTROL_PLANE_PERMISSION);
    await enqueueDeploy({ kind: data.task });
    return { queued: true };
  });

export const reloadWebServer = createServerFn({ method: "POST" }).handler(
  async (): Promise<{ queued: true }> => {
    await requirePermission(CONTROL_PLANE_PERMISSION);
    const host = await db.query.servers.findFirst({
      where: eq(servers.isSelf, true),
    });
    if (!host) {
      throw new Error(
        "This Noddle was not installed by install.sh, so it cannot reload its own host."
      );
    }
    await enqueueDeploy({ kind: "reload-control-plane" });
    return { queued: true };
  }
);
