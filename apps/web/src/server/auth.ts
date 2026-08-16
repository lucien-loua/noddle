import { createServerFn } from "@tanstack/react-start";

import { needsSetup } from "@/lib/auth.server";
import { getSession } from "@/lib/session.server";

export interface AuthState {
  email: string | null;
  /** No administrator exists yet: the first screen is a creation flow. */
  needsSetup: boolean;
  /** The signed-in account's role. Used for client-side HIDING only, never
   *  for deciding: it's `requirePermission` that decides, server-side. */
  role: string | null;
  signedIn: boolean;
}

export const getAuthState = createServerFn({ method: "GET" }).handler(
  async (): Promise<AuthState> => {
    const session = await getSession();
    return {
      email: session?.user.email ?? null,
      // Queried even when signed in: it's a single `count` query, and it
      // saves the router a second round trip right when it needs one.
      needsSetup: await needsSetup(),
      role: (session?.user as { role?: string } | undefined)?.role ?? null,
      signedIn: session !== null,
    };
  }
);
