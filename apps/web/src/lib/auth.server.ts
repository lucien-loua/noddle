// biome-ignore lint/performance/noNamespaceImport: drizzleAdapter wants the schema object

import { deriveSubkey } from "@noddle/crypto";
import * as schema from "@noddle/db/schema";
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
          // The first account is `owner`, and that's what makes an
          // installation usable: without it, nobody could create the
          // second one.
          return { data: { ...user, role: "owner" } };
        },
      },
    },
  },

  emailAndPassword: {
    enabled: true,
    // No SMTP server to configure just to log into your own machine.
    requireEmailVerification: false,
  },

  plugins: [
    adminPlugin({
      ac,
      // `owner` MUST be listed here: the plugin guards its own endpoints
      // (create-user, set-role, remove-user) behind this list, which
      // defaults to ["admin"], and our installation role is called `owner`.
      adminRoles: ["owner", "admin"],
      // `viewer` by default: a freshly created account must not be able to
      // break anything before it's been given its role. The reverse —
      // administrator by default, later demoted — leaves a window during
      // which forgetting is costly.
      defaultRole: "viewer",
      roles,
    }),
  ],

  // Derived from APP_KEY rather than added alongside it: a single secret
  // root to generate and save in the installer.
  secret: deriveSubkey(env.appKey, "noddle-better-auth").toString("base64"),
});

export type Session = typeof auth.$Infer.Session;
