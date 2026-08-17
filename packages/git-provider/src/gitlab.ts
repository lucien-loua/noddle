/**
 * GitLab OAuth access, per ADR-0019.
 *
 * GitLab has no equivalent of a GitHub App, so this really is OAuth: a
 * stored access token that EXPIRES, and a refresh token to renew it. That
 * asymmetry with GitHub is the platform's, not a design choice — do not
 * fold the two into shared token handling.
 */

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
  /** Epoch millis. */
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

/** Where the browser is sent to authorise. `state` identifies the row. */
export function authorizeUrl(app: GitlabApp, state: string): string {
  const base = app.url.replace(TRAILING_SLASHES, "");
  const params = new URLSearchParams({
    client_id: app.applicationId,
    redirect_uri: app.redirectUri,
    response_type: "code",
    // `api` is what lists projects and branches; `read_repository` alone
    // cannot enumerate. Nothing write-scoped is requested.
    scope: "api read_repository",
    state,
  });
  return `${base}/oauth/authorize?${params.toString()}`;
}

/** Exchange the authorisation code for the first pair of tokens. */
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

/**
 * A minute of margin before expiry.
 *
 * Refreshing is done BEFORE use, never lazily on a 401: a 401 arrives
 * mid-deploy and surfaces as a failed build rather than as an expired
 * token. The margin covers the clone that starts just before the token
 * would have died.
 */
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
  /** `group/project`. */
  fullName: string;
  url: string;
}

interface RawProject {
  default_branch?: string;
  http_url_to_repo: string;
  path_with_namespace: string;
}

/** Projects the token can see, following pagination. */
export async function listProjects(
  url: string,
  accessToken: string,
  fetchImpl: GitlabFetch = fetch
): Promise<GitlabRepo[]> {
  const repos: GitlabRepo[] = [];

  // Bounded, like the GitHub side: a remote that keeps answering full
  // pages is how a deploy queue stops moving.
  for (let page = 1; page <= 20; page += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: pagination is sequential by nature
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

/** Branch names of one project. `fullName` is URL-encoded for the path. */
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

/**
 * The URL git clones with, carrying the access token.
 *
 * A SECRET that looks like a URL (ADR-0019). `redactUrlCredentials` in the
 * log sink is the net that catches it; this is built at the moment of the
 * clone and discarded.
 */
export function cloneUrlWithToken(repoUrl: string, token: string): string {
  const parsed = new URL(repoUrl);
  parsed.username = "oauth2";
  parsed.password = token;
  return parsed.toString();
}

// ─────────────────────────────────────────────────────────────────────────────
// Project hooks
// ─────────────────────────────────────────────────────────────────────────────

// GitLab has no application-level webhook: hooks belong to a project, so one
// is registered per repository. The token's user must be Maintainer or better,
// or GitLab answers 403.

export interface GitlabHook {
  id: string;
  url: string;
}

function projectHooksUrl(url: string, fullName: string): string {
  return `${apiBase(url)}/projects/${encodeURIComponent(fullName)}/hooks`;
}

/** Hooks already on the project — how a duplicate is avoided. */
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

/**
 * Push and merge-request events on one hook, matching the GitHub App's
 * `default_events`. GitLab returns `token` in `x-gitlab-token` rather than
 * signing the body.
 */
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

/** Repoint an existing hook. Used when the dashboard's public origin moves. */
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

/** A 404 is success: the end state asked for is that the hook is gone. */
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
