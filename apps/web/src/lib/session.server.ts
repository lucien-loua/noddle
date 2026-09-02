import { getRequestHeaders } from "@tanstack/react-start/server";

import { auth } from "@/lib/auth.server";
import type { Session } from "@/lib/auth.server";

export async function getSession(): Promise<Session | null> {
  return await auth.api.getSession({ headers: getRequestHeaders() });
}

export async function requireSession(): Promise<Session> {
  const session = await getSession();
  if (!session) {
    throw new Error("not authenticated");
  }
  return session;
}
