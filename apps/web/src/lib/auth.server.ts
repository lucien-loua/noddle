import { deriveSubkey } from "@noddle/crypto";
// biome-ignore lint/performance/noNamespaceImport: drizzleAdapter wants the schema object
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

async function userCount(): Promise<number> {
  const [row] = await db.select({ value: count() }).from(schema.user);
  return row?.value ?? 0;
}

/** True as long as no administrator exists: the first screen is then
 *  account creation, not a login. */
export async function needsSetup(): Promise<boolean> {
  return (await userCount()) === 0;
}

export const auth = betterAuth({
  // `baseURL` is NOT set here, and that's deliberate: nobody knows at build
  // time what address a user will reach THEIR machine at. Absent that,
  // better-auth derives the origin from the incoming request, which is
  // enough in development. In production, the installer sets
  // BETTER_AUTH_URL — better-auth's own variable, read without a single
  // line of our code — and the origin is then verified instead of taken
  // on faith.
  database: drizzleAdapter(db, { provider: "pg", schema }),

  // Sign-up is the mechanism for creating the FIRST account, and only that
  // one. The lock is here rather than in the interface: the
  // /api/auth/sign-up/email endpoint is directly reachable, hiding the
  // form wouldn't protect anything.
  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          // WARNING — this hook applies to EVERY account creation, including
          // the `admin` plugin's own. The first version assumed the
          // opposite and therefore blocked `admin.createUser`: the
          // installation stayed at one account forever, the lock blocking
          // the very mechanism meant to replace it. Measured, 403 on
          // create-user.
          //
          // So we let the request through when it comes from an already
          // authenticated account: only an administrator reaches this
          // endpoint, since the plugin itself guards it via `adminRoles`.
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
    // Set from the same constants the sign-up form validates against. Left
    // to their defaults, the two would drift the day the form's rule moves,
    // and the mismatch only shows up as an API error on a password the
    // screen already accepted.
    maxPasswordLength: MAX_PASSWORD_LENGTH,
    minPasswordLength: MIN_PASSWORD_LENGTH,
    // No SMTP server to configure just to log into your own machine.
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
  secret: deriveSubkey(env.appKey, "noddle-better-auth").toString("base64"),
});

export type Session = typeof auth.$Infer.Session;
