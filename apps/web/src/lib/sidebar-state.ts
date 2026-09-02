import { createIsomorphicFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";

const COOKIE = "sidebar_state";

function isOpen(cookieHeader: string): boolean {
  return !cookieHeader.includes(`${COOKIE}=false`);
}

export const readSidebarOpen = createIsomorphicFn()
  .server(() => isOpen(getRequestHeaders().get("cookie") ?? ""))
  .client(() => isOpen(document.cookie));
