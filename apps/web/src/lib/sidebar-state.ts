import { createIsomorphicFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";

/** The cookie `SidebarProvider` writes on every toggle. */
const COOKIE = "sidebar_state";

function isOpen(cookieHeader: string): boolean {
  // Absent = never toggled, and the sidebar opens by default.
  return !cookieHeader.includes(`${COOKIE}=false`);
}

/**
 * The sidebar's persisted state, read the SAME way on both sides.
 *
 * The preset already writes the cookie; nothing read it back, so a closed
 * sidebar reopened on every reload. It has to be resolved BEFORE the first
 * paint — reading it in an effect would render the sidebar open, then
 * collapse it, which is the flash the theme script exists to avoid.
 *
 * `createIsomorphicFn` keeps `getRequestHeaders` out of the client bundle
 * and lets the browser answer from `document.cookie` — so a client
 * navigation costs no round trip, and the server render and the hydration
 * read the same value.
 */
export const readSidebarOpen = createIsomorphicFn()
  .server(() => isOpen(getRequestHeaders().get("cookie") ?? ""))
  .client(() => isOpen(document.cookie));
