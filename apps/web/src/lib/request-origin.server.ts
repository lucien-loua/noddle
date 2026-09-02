import { getRequestHeaders } from "@tanstack/react-start/server";

export function requestOrigin(): string {
  const headers = getRequestHeaders();
  const host = headers.get("x-forwarded-host") ?? headers.get("host");
  if (!host) {
    throw new Error("cannot determine this dashboard's public URL");
  }
  const proto = headers.get("x-forwarded-proto") ?? "https";
  return `${proto}://${host}`;
}

export function gitlabHookUrl(gitProviderId: string): string {
  return `${requestOrigin()}/api/webhooks/gitlab/${gitProviderId}`;
}
