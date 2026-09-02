import { createSign } from "node:crypto";

export class GithubError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "GithubError";
    this.status = status;
  }
}

const TRAILING_SLASHES = /\/+$/;

function base64Url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export function appJwt(
  appId: string,
  privateKeyPem: string,
  now: number = Date.now()
): string {
  const issued = Math.floor(now / 1000) - 60;
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({ exp: issued + 540, iat: issued, iss: appId })
  );
  const signingInput = `${header}.${payload}`;

  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  return `${signingInput}.${base64Url(signer.sign(privateKeyPem))}`;
}

export interface GithubApp {
  appId: string;
  installationId: string;
  privateKeyPem: string;
  url: string;
}

export function apiBase(url: string): string {
  const trimmed = url.replace(TRAILING_SLASHES, "");
  return trimmed === "https://github.com"
    ? "https://api.github.com"
    : `${trimmed}/api/v3`;
}

type GithubFetch = (url: string, init?: RequestInit) => Promise<Response>;

async function githubJson<T>(
  fetchImpl: GithubFetch,
  url: string,
  init: RequestInit
): Promise<T> {
  const response = await fetchImpl(url, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...init.headers,
    },
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new GithubError(
      `GitHub responded ${response.status}: ${detail.slice(0, 300)}`,
      response.status
    );
  }
  return (await response.json()) as T;
}

export interface InstallationToken {
  expiresAt: number;
  token: string;
}

export async function installationToken(
  app: GithubApp,
  fetchImpl: GithubFetch = fetch
): Promise<InstallationToken> {
  const jwt = appJwt(app.appId, app.privateKeyPem);
  const body = await githubJson<{ expires_at: string; token: string }>(
    fetchImpl,
    `${apiBase(app.url)}/app/installations/${app.installationId}/access_tokens`,
    { headers: { Authorization: `Bearer ${jwt}` }, method: "POST" }
  );
  return {
    expiresAt: Date.parse(body.expires_at),
    token: body.token,
  };
}

export interface GithubInstallation {
  account: string;
  id: string;
}

export async function listInstallations(
  app: { appId: string; privateKeyPem: string; url: string },
  fetchImpl: GithubFetch = fetch
): Promise<GithubInstallation[]> {
  const jwt = appJwt(app.appId, app.privateKeyPem);
  const body = await githubJson<{ account?: { login?: string }; id: number }[]>(
    fetchImpl,
    `${apiBase(app.url)}/app/installations?per_page=100`,
    {
      headers: { Authorization: `Bearer ${jwt}` },
    }
  );
  return body.map((i) => ({
    account: i.account?.login ?? "unknown",
    id: String(i.id),
  }));
}

export interface GithubRepo {
  defaultBranch: string;
  fullName: string;
  private: boolean;
  url: string;
}

interface RawRepo {
  clone_url: string;
  default_branch: string;
  full_name: string;
  private: boolean;
}

export async function listRepositories(
  app: GithubApp,
  fetchImpl: GithubFetch = fetch
): Promise<GithubRepo[]> {
  const { token } = await installationToken(app, fetchImpl);
  const repos: GithubRepo[] = [];

  for (let page = 1; page <= 20; page += 1) {
    const body = await githubJson<{ repositories: RawRepo[] }>(
      fetchImpl,
      `${apiBase(app.url)}/installation/repositories?per_page=100&page=${page}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    for (const r of body.repositories) {
      repos.push({
        defaultBranch: r.default_branch,
        fullName: r.full_name,
        private: r.private,
        url: r.clone_url,
      });
    }
    if (body.repositories.length < 100) {
      break;
    }
  }
  return repos;
}

export async function listBranches(
  app: GithubApp,
  fullName: string,
  fetchImpl: GithubFetch = fetch
): Promise<string[]> {
  const { token } = await installationToken(app, fetchImpl);
  const body = await githubJson<{ name: string }[]>(
    fetchImpl,
    `${apiBase(app.url)}/repos/${fullName}/branches?per_page=100`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return body.map((b) => b.name);
}

export function cloneUrlWithToken(repoUrl: string, token: string): string {
  const parsed = new URL(repoUrl);
  parsed.username = "x-access-token";
  parsed.password = token;
  return parsed.toString();
}

export function redactCloneUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return "<repository>";
  }
}

const PRIVATE_HOST =
  /^(localhost|127\.|0\.0\.0\.0|\[?::1\]?|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)|\.(local|localhost|internal|test)$/i;

export function isPubliclyReachable(origin: string): boolean {
  try {
    return !PRIVATE_HOST.test(new URL(origin).hostname);
  } catch {
    return false;
  }
}

export function appManifest(o: {
  name: string;
  redirectUrl: string;
  url: string;
  webhookUrl: string;
}): Record<string, unknown> {
  return {
    default_events: ["push", "pull_request"],
    default_permissions: {
      contents: "read",
      metadata: "read",
      pull_requests: "read",
    },
    hook_attributes: { active: true, url: o.webhookUrl },
    name: o.name,
    public: false,
    redirect_url: o.redirectUrl,
    setup_url: o.redirectUrl,
    url: o.url,
  };
}

export interface CreatedApp {
  appId: string;
  clientId: string;
  clientSecret: string;
  htmlUrl: string;
  name: string;
  pem: string;
  webhookSecret: string;
}

export async function exchangeManifestCode(
  code: string,
  url: string,
  fetchImpl: GithubFetch = fetch
): Promise<CreatedApp> {
  const body = await githubJson<{
    client_id: string;
    client_secret: string;
    html_url: string;
    id: number;
    name: string;
    pem: string;
    webhook_secret: string;
  }>(fetchImpl, `${apiBase(url)}/app-manifests/${code}/conversions`, {
    method: "POST",
  });

  return {
    appId: String(body.id),
    clientId: body.client_id,
    clientSecret: body.client_secret,
    htmlUrl: body.html_url,
    name: body.name,
    pem: body.pem,
    webhookSecret: body.webhook_secret,
  };
}

export function installUrl(htmlUrl: string): string {
  return `${htmlUrl.replace(TRAILING_SLASHES, "")}/installations/new`;
}
