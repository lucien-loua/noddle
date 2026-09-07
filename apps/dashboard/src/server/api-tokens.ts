import { apikey } from "@noddle/db/schema";
import {
  DEFAULT_TOKEN_LIFETIME_MS,
  MAX_TOKEN_LIFETIME_DAYS,
} from "@noddle/shared/api-token";
import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { auth } from "@/lib/auth.server";
import { db } from "@/lib/db.server";
import { runGuarded } from "@/lib/permission.server";
import { grantableBy, narrowToRole, scopesToPermissions } from "@/lib/scopes";
import { requireSession } from "@/lib/session.server";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_NAME = 60;

export interface ApiTokenRow {
  createdAt: Date;
  effectiveScopes: string[];
  expiresAt: Date | null;
  grantedScopes: string[];
  id: string;
  lastRequest: Date | null;
  name: string;
  start: string | null;
}

const createSchema = z.object({
  expiresInDays: z
    .number()
    .int()
    .min(1)
    .max(MAX_TOKEN_LIFETIME_DAYS)
    .nullable(),
  name: z.string().trim().min(1).max(MAX_NAME),
  scopes: z.array(z.string()).min(1),
});

function parsePermissions(raw: string | null): Record<string, string[]> {
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw) as Record<string, string[]>;
  } catch {
    return {};
  }
}

export const getApiTokens = createServerFn().handler(
  async (): Promise<ApiTokenRow[]> => {
    const session = await requireSession();
    const role = session.user.role ?? null;

    const rows = await db
      .select()
      .from(apikey)
      .where(eq(apikey.referenceId, session.user.id))
      .orderBy(desc(apikey.createdAt));

    return rows
      .filter((row) => row.enabled)
      .map((row) => {
        const granted = Object.entries(parsePermissions(row.permissions))
          .flatMap(([resource, actions]) =>
            actions.map((action) => `${resource}:${action}`)
          )
          .toSorted();
        return {
          createdAt: row.createdAt,
          effectiveScopes: narrowToRole(granted, role),
          expiresAt: row.expiresAt,
          grantedScopes: granted,
          id: row.id,
          lastRequest: row.lastRequest,
          name: row.name ?? "unnamed",
          start: row.start,
        };
      });
  }
);

export const getGrantableScopes = createServerFn().handler(
  async (): Promise<string[]> => {
    const session = await requireSession();
    return grantableBy(session.user.role ?? null);
  }
);

export const createApiToken = createServerFn({ method: "POST" })
  .validator(createSchema)
  .handler(
    async ({ data }): Promise<{ id: string; token: string }> =>
      await runGuarded({
        permission: { action: "create", resource: "apiToken" },
        run: async ({ session }) => {
          const role = session.user.role ?? null;
          const scopes = narrowToRole(data.scopes, role);
          if (scopes.length !== data.scopes.length) {
            throw new Error(
              "A token cannot hold a permission your role does not grant."
            );
          }

          const created = await auth.api.createApiKey({
            body: {
              expiresIn: data.expiresInDays
                ? (data.expiresInDays * DAY_MS) / 1000
                : DEFAULT_TOKEN_LIFETIME_MS / 1000,
              name: data.name,
              permissions: scopesToPermissions(scopes),
              userId: session.user.id,
            },
            headers: getRequestHeaders(),
          });

          return { id: created.id, token: created.key };
        },
        target: ({ result }) => ({ id: result.id, name: data.name }),
      })
  );

export const revokeApiToken = createServerFn({ method: "POST" })
  .validator(z.object({ id: z.string().min(1), typedName: z.string() }))
  .handler(
    async ({ data }): Promise<{ revoked: true }> =>
      await runGuarded({
        confirmName: {
          expected: (row) => row.name ?? "",
          typed: data.typedName,
        },
        load: async () => {
          const session = await requireSession();
          const [row] = await db
            .select()
            .from(apikey)
            .where(
              and(
                eq(apikey.id, data.id),
                eq(apikey.referenceId, session.user.id)
              )
            );
          return row;
        },
        notFoundMessage: "token not found",
        permission: { action: "delete", resource: "apiToken" },
        run: async ({ row }) => {
          await db
            .update(apikey)
            .set({ enabled: false })
            .where(eq(apikey.id, row.id));
          return { revoked: true as const };
        },
        target: ({ row }) => ({ id: row.id, name: row.name }),
      })
  );
