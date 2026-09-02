export class GitlabError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "GitlabError";
    this.status = status;
  }
}

const TRAILING_SLASHES = /\/+$/;

export function apiBase(url: string): string {
  return `${url.replace(TRAILING_SLASHES, "")}/api/v4`;
}

type GitlabFetch = (url: string, init?: RequestInit) => Promise<Response>;

async function gitlabJson<T>(
  fetchImpl: GitlabFetch,
  url: string,
  init: RequestInit = {}
): Promise<T> {
  const response = await fetchImpl(url, init);
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new GitlabError(
      `GitLab responded ${response.status}: ${detail.slice(0, 300)}`,
      response.status
    );
  }
  return (await response.json()) as T;
}

export interface GitlabTokens {
  accessToken: string;
  expiresAt: number;
  refreshToken: string;
}

interface RawTokens {
  access_token: string;
  created_at?: number;
  expires_in: number;
  refresh_token: string;
}

function toTokens(raw: RawTokens, now: number): GitlabTokens {
  return {
    accessToken: raw.access_token,
    expiresAt: now + raw.expires_in * 1000,
    refreshToken: raw.refresh_token,
  };
}

export interface GitlabApp {
  applicationId: string;
  redirectUri: string;
  secret: string;
  url: string;
}

export function authorizeUrl(app: GitlabApp, state: string): string {
  const base = app.url.replace(TRAILING_SLASHES, "");
  const params = new URLSearchParams({
    client_id: app.applicationId,
    redirect_uri: app.redirectUri,
    response_type: "code",
    scope: "api read_repository",
    state,
  });
  return `${base}/oauth/authorize?${params.toString()}`;
}

export function exchangeCode(
  app: GitlabApp,
  code: string,
  fetchImpl: GitlabFetch = fetch,
  now: number = Date.now()
): Promise<GitlabTokens> {
  return gitlabJson<RawTokens>(
    fetchImpl,
    `${app.url.replace(TRAILING_SLASHES, "")}/oauth/token`,
    {
      body: new URLSearchParams({
        client_id: app.applicationId,
        client_secret: app.secret,
        code,
        grant_type: "authorization_code",
        redirect_uri: app.redirectUri,
      }),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    }
  ).then((raw) => toTokens(raw, now));
}

const EXPIRY_MARGIN_MS = 60_000;

export function needsRefresh(
  expiresAt: number | null,
  now: number = Date.now()
): boolean {
  return expiresAt === null || now + EXPIRY_MARGIN_MS >= expiresAt;
}

export function refreshTokens(
  app: GitlabApp,
  refreshToken: string,
  fetchImpl: GitlabFetch = fetch,
  now: number = Date.now()
): Promise<GitlabTokens> {
  return gitlabJson<RawTokens>(
    fetchImpl,
    `${app.url.replace(TRAILING_SLASHES, "")}/oauth/token`,
    {
      body: new URLSearchParams({
        client_id: app.applicationId,
        client_secret: app.secret,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    }
  ).then((raw) => toTokens(raw, now));
}

export interface GitlabRepo {
  defaultBranch: string;
  fullName: string;
  url: string;
}

interface RawProject {
  default_branch?: string;
  http_url_to_repo: string;
  path_with_namespace: string;
}

export async function listProjects(
  url: string,
  accessToken: string,
  fetchImpl: GitlabFetch = fetch
): Promise<GitlabRepo[]> {
  const repos: GitlabRepo[] = [];

  for (let page = 1; page <= 20; page += 1) {
    const body = await gitlabJson<RawProject[]>(
      fetchImpl,
      `${apiBase(url)}/projects?membership=true&per_page=100&page=${page}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    for (const p of body) {
      repos.push({
        defaultBranch: p.default_branch ?? "main",
        fullName: p.path_with_namespace,
        url: p.http_url_to_repo,
      });
    }
    if (body.length < 100) {
      break;
    }
  }
  return repos;
}

export async function listBranches(
  url: string,
  accessToken: string,
  fullName: string,
  fetchImpl: GitlabFetch = fetch
): Promise<string[]> {
  const body = await gitlabJson<{ name: string }[]>(
    fetchImpl,
    `${apiBase(url)}/projects/${encodeURIComponent(fullName)}/repository/branches?per_page=100`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  return body.map((b) => b.name);
}

export function cloneUrlWithToken(repoUrl: string, token: string): string {
  const parsed = new URL(repoUrl);
  parsed.username = "oauth2";
  parsed.password = token;
  return parsed.toString();
}

export interface GitlabHook {
  id: string;
  url: string;
}

function projectHooksUrl(url: string, fullName: string): string {
  return `${apiBase(url)}/projects/${encodeURIComponent(fullName)}/hooks`;
}

export async function listProjectHooks(
  url: string,
  accessToken: string,
  fullName: string,
  fetchImpl: GitlabFetch = fetch
): Promise<GitlabHook[]> {
  const body = await gitlabJson<{ id: number; url: string }[]>(
    fetchImpl,
    `${projectHooksUrl(url, fullName)}?per_page=100`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  return body.map((h) => ({ id: String(h.id), url: h.url }));
}

export async function createProjectHook(
  url: string,
  accessToken: string,
  fullName: string,
  hook: { hookUrl: string; token: string },
  fetchImpl: GitlabFetch = fetch
): Promise<GitlabHook> {
  const body = await gitlabJson<{ id: number; url: string }>(
    fetchImpl,
    projectHooksUrl(url, fullName),
    {
      body: new URLSearchParams({
        enable_ssl_verification: "true",
        merge_requests_events: "true",
        push_events: "true",
        token: hook.token,
        url: hook.hookUrl,
      }),
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    }
  );
  return { id: String(body.id), url: body.url };
}

export async function updateProjectHook(
  url: string,
  accessToken: string,
  fullName: string,
  hookId: string,
  hook: { hookUrl: string; token: string },
  fetchImpl: GitlabFetch = fetch
): Promise<GitlabHook> {
  const body = await gitlabJson<{ id: number; url: string }>(
    fetchImpl,
    `${projectHooksUrl(url, fullName)}/${hookId}`,
    {
      body: new URLSearchParams({
        enable_ssl_verification: "true",
        merge_requests_events: "true",
        push_events: "true",
        token: hook.token,
        url: hook.hookUrl,
      }),
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      method: "PUT",
    }
  );
  return { id: String(body.id), url: body.url };
}

export async function deleteProjectHook(
  url: string,
  accessToken: string,
  fullName: string,
  hookId: string,
  fetchImpl: GitlabFetch = fetch
): Promise<void> {
  const response = await fetchImpl(
    `${projectHooksUrl(url, fullName)}/${hookId}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      method: "DELETE",
    }
  );
  if (!(response.ok || response.status === 404)) {
    const detail = await response.text().catch(() => "");
    throw new GitlabError(
      `GitLab responded ${response.status}: ${detail.slice(0, 300)}`,
      response.status
    );
  }
}
