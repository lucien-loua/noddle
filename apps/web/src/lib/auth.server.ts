import { deriveSubkey } from "@noddle/crypto";
import * as schema from "@noddle/db/schema";
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
} from "@noddle/shared/validation/account";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { admin as adminPlugin } from "better-auth/plugins";
import { count } from "drizzle-orm";

import { db } from "@/lib/db.server";
import { env } from "@/lib/env.server";
import { ac, roles } from "@/lib/permissions";

function forwardedOrigin(request: Request): string | null {
  const host =
    request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!host) {
    return null;
  }
  const proto = request.headers.get("x-forwarded-proto") ?? "http";
  return `${proto}://${host}`;
}

async function userCount(): Promise<number> {
  const [row] = await db.select({ value: count() }).from(schema.user);
  return row?.value ?? 0;
}

export async function needsSetup(): Promise<boolean> {
  return (await userCount()) === 0;
}

const HTTPS_BASE_URL = (process.env.BETTER_AUTH_URL ?? "").startsWith(
  "https://"
);

export const auth = betterAuth({
  advanced: { useSecureCookies: HTTPS_BASE_URL },

  database: drizzleAdapter(db, { provider: "pg", schema }),

  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          const existing = await auth.api
            .getSession({ headers: getRequestHeaders() })
            .catch(() => null);
          if (existing) {
            return;
          }
          if ((await userCount()) > 0) {
            throw new APIError("FORBIDDEN", {
              message:
                "Sign-up is reserved for the first account. Ask an admin to create one for you.",
            });
          }
          return { data: { ...user, role: "owner" } };
        },
      },
    },
  },

  emailAndPassword: {
    enabled: true,
    maxPasswordLength: MAX_PASSWORD_LENGTH,
    minPasswordLength: MIN_PASSWORD_LENGTH,
    requireEmailVerification: false,
  },

  plugins: [
    adminPlugin({
      ac,
      adminRoles: ["owner", "admin"],
      defaultRole: "viewer",
      roles,
    }),
  ],
  rateLimit: { enabled: true },
  secret: deriveSubkey(env.appKey, "noddle-better-auth").toString("base64"),

  trustedOrigins: (request) => {
    if (
      process.env.NODE_ENV === "production" ||
      process.env.BETTER_AUTH_URL ||
      !request
    ) {
      return [];
    }
    const origin = forwardedOrigin(request);
    return origin ? [origin] : [];
  },
});

export type Session = typeof auth.$Infer.Session;
