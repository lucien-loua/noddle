import { createServerFn } from "@tanstack/react-start";

import { needsSetup } from "@/lib/auth.server";
import { getSession } from "@/lib/session.server";

export interface AuthState {
  email: string | null;
  needsSetup: boolean;
  role: string | null;
  signedIn: boolean;
}

export const getAuthState = createServerFn({ method: "GET" }).handler(
  async (): Promise<AuthState> => {
    const session = await getSession();
    return {
      email: session?.user.email ?? null,
      needsSetup: await needsSetup(),
      role: (session?.user as { role?: string } | undefined)?.role ?? null,
      signedIn: session !== null,
    };
  }
);
