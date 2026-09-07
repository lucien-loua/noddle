export interface Config {
  token: string;
  url: string;
}

export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

export function resolveConfig(
  flags: { token?: string; url?: string },
  env: Record<string, string | undefined>
): Config {
  const url = (flags.url ?? env.NODDLE_URL ?? "").replace(/\/+$/, "");
  const token = flags.token ?? env.NODDLE_TOKEN ?? "";

  if (!url) {
    throw new CliError(
      "No Noddle address. Pass --url or set NODDLE_URL, for example https://noddle.example.com"
    );
  }
  if (!token) {
    throw new CliError(
      "No token. Pass --token or set NODDLE_TOKEN. Create one under Settings, API tokens."
    );
  }
  return { token, url };
}

export interface ApiFailure {
  error?: string;
  message?: string;
}

export function describeFailure(status: number, body: ApiFailure): string {
  if (status === 401) {
    return "That token was refused. It may be revoked, expired, or for another Noddle.";
  }
  if (status === 403) {
    return body.message ?? "This token does not carry the needed permission.";
  }
  if (status === 404) {
    return body.message ?? "Not found.";
  }
  return body.message ?? `The request failed (HTTP ${status}).`;
}

export function createClient(config: Config, fetcher: typeof fetch = fetch) {
  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetcher(`${config.url}${path}`, {
      ...init,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${config.token}`,
        ...init.headers,
      },
    });

    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      throw new CliError(
        `${config.url}${path} did not answer with JSON. Is that address a Noddle?`
      );
    }

    if (!response.ok) {
      throw new CliError(describeFailure(response.status, body as ApiFailure));
    }
    return body as T;
  }

  return {
    deploy: (serviceId: string, idempotencyKey: string) =>
      request<{ deploymentId: string; service: { name: string } }>(
        `/api/v1/services/${encodeURIComponent(serviceId)}/deploy`,
        { headers: { "idempotency-key": idempotencyKey }, method: "POST" }
      ),
    deployment: (id: string) =>
      request<{
        done: boolean;
        finishedAt: string | null;
        id: string;
        status: string;
      }>(`/api/v1/deployments/${encodeURIComponent(id)}`),
    servers: () =>
      request<{
        servers: { host: string; id: string; name: string; status: string }[];
      }>("/api/v1/servers"),
    services: () =>
      request<{
        services: {
          displayName: string | null;
          id: string;
          name: string;
          status: string;
        }[];
      }>("/api/v1/services"),
    whoami: () =>
      request<{
        email: string;
        role: string | null;
        scopes: string[];
        token: { name: string };
      }>("/api/v1/whoami"),
  };
}

export const FAILED_STATUSES = new Set([
  "failed",
  "rolled_back",
  "reverted_by_watch",
]);

export function deploymentExitCode(status: string): number {
  return FAILED_STATUSES.has(status) ? 1 : 0;
}
