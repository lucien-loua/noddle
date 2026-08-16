import { redirect } from "@tanstack/react-router";

import { getAuthState } from "@/server/auth";

/** Signed-in gate shared by service, database, and stack detail routes. */
export async function resourceDetailBeforeLoad() {
  const state = await getAuthState();
  if (!state.signedIn) {
    throw redirect({ to: "/login" });
  }
  return { email: state.email, role: state.role };
}
