import { serviceDomains, services } from "@noddle/db/schema";
import { generateTestDomain } from "@noddle/shared/generate-domain";
import {
  createServiceDomainSchema,
  deleteServiceDomainSchema,
  generateServiceDomainHostSchema,
  updateServiceDomainSchema,
} from "@noddle/shared/validation/service";
import { createServerFn } from "@tanstack/react-start";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db.server";
import { guarded } from "@/lib/guarded.server";
import { hostsInUse } from "@/lib/installation-queries.server";
import { runGuarded } from "@/lib/permission.server";
import { domainInTeam, serviceInContext } from "@/lib/team-queries.server";
import { activeTeamId } from "@/lib/team-scope.server";

async function assertHostAvailable(host: string, exceptId?: string) {
  const taken = await hostsInUse(db, [host], exceptId);
  if (taken.size > 0) {
    throw new Error(`"${host}" is already used by another application`);
  }
}

async function loadDomain(domainId: string) {
  return await domainInTeam(db, await activeTeamId(), domainId);
}

function normalizePathInput(path: string | undefined): string {
  const trimmed = path?.trim() ?? "";
  if (trimmed === "" || trimmed === "/") {
    return "/";
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function normalizeInternalPathInput(path: string | undefined): string | null {
  const trimmed = path?.trim() ?? "";
  if (trimmed === "" || trimmed === "/") {
    return null;
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function domainValuesFromInput(data: {
  certificateType: "none" | "letsencrypt";
  host: string;
  https: boolean;
  internalPath?: string;
  path?: string;
  stripPath: boolean;
}) {
  return {
    certificateType: data.certificateType,
    host: data.host,
    https: data.https,
    internalPath: normalizeInternalPathInput(data.internalPath),
    path: normalizePathInput(data.path),
    stripPath: data.stripPath,
  };
}

export const createServiceDomain = createServerFn({ method: "POST" })
  .validator(createServiceDomainSchema)
  .handler(async ({ data }): Promise<{ id: string }> =>
    runGuarded({
      ...guarded.service(data.serviceId),
      permission: { action: "deploy", resource: "service" },
      run: async ({ row: service }) => {
        await assertHostAvailable(data.host);
        const [created] = await db
          .insert(serviceDomains)
          .values({
            ...domainValuesFromInput(data),
            serviceId: service.id,
          })
          .returning();
        if (!created) {
          throw new Error("could not create domain");
        }
        if (data.port !== service.port) {
          await db
            .update(services)
            .set({ port: data.port })
            .where(eq(services.id, service.id));
        }
        return { id: created.id };
      },
      target: ({ row }) => ({ id: row.id, name: row.name }),
    })
  );

export const updateServiceDomain = createServerFn({ method: "POST" })
  .validator(updateServiceDomainSchema)
  .handler(async ({ data }): Promise<{ ok: true }> =>
    runGuarded({
      load: () => loadDomain(data.domainId),
      notFoundMessage: "domain not found",
      permission: { action: "deploy", resource: "service" },
      run: async ({ row: domainRow }) => {
        await assertHostAvailable(data.host, domainRow.id);
        await db
          .update(serviceDomains)
          .set(domainValuesFromInput(data))
          .where(eq(serviceDomains.id, domainRow.id));
        if (data.port !== domainRow.service.port) {
          await db
            .update(services)
            .set({ port: data.port })
            .where(eq(services.id, domainRow.serviceId));
        }
        return { ok: true as const };
      },
      target: ({ row }) => ({
        id: row.service.id,
        name: row.service.name,
      }),
    })
  );

const GENERATED_HOST_ATTEMPTS = 8;

export const generateServiceDomainHost = createServerFn({ method: "POST" })
  .validator(generateServiceDomainHostSchema)
  .handler(async ({ data }): Promise<{ host: string }> =>
    runGuarded({
      load: async () =>
        serviceInContext(db, await activeTeamId(), data.serviceId),
      notFoundMessage: "service not found",
      permission: { action: "deploy", resource: "service" },
      run: async ({ row: service }) => {
        const candidates = Array.from({ length: GENERATED_HOST_ATTEMPTS }, () =>
          generateTestDomain({
            appName: service.name,
            serverHost: service.server.host,
          })
        );
        const takenHosts = await hostsInUse(db, candidates);
        const host = candidates.find((candidate) => !takenHosts.has(candidate));
        if (!host) {
          throw new Error(
            "could not find an unused test domain: try again or enter a host manually"
          );
        }
        return { host };
      },
      target: ({ row }) => ({ id: row.id, name: row.name }),
    })
  );

export const deleteServiceDomain = createServerFn({ method: "POST" })
  .validator(deleteServiceDomainSchema)
  .handler(async ({ data }): Promise<{ ok: true }> =>
    runGuarded({
      load: () => loadDomain(data.domainId),
      notFoundMessage: "domain not found",
      permission: { action: "deploy", resource: "service" },
      run: async ({ row: domainRow }) => {
        await db
          .delete(serviceDomains)
          .where(eq(serviceDomains.id, domainRow.id));
        return { ok: true as const };
      },
      target: ({ row }) => ({
        id: row.service.id,
        name: row.service.name,
      }),
    })
  );
