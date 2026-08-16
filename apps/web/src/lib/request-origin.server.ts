import { getRequestHeaders } from "@tanstack/react-start/server";

/**
 * The dashboard's own public origin, taken from the request rather than a
 * setting: a forge has to reach it, and the host the operator is using is the
 * only one known to work.
 */
export function requestOrigin(): string {
  const headers = getRequestHeaders();
  const host = headers.get("x-forwarded-host") ?? headers.get("host");
  if (!host) {
    throw new Error("cannot determine this dashboard's public URL");
  }
  const proto = headers.get("x-forwarded-proto") ?? "https";
  return `${proto}://${host}`;
}

/** Where a Repository hook for this connection must point. */
export function gitlabHookUrl(gitProviderId: string): string {
  return `${requestOrigin()}/api/webhooks/gitlab/${gitProviderId}`;
}
