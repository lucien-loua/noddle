import { createSign } from "node:crypto";

/**
 * GitHub App access, per ADR-0019.
 *
 * The App is created by the OPERATOR from their own instance. Nothing here
 * is a Noddle-owned credential.
 *
 * The chain is always the same three steps, and skipping one is the usual
 * mistake: sign a JWT with the App's private key → exchange it for an
 * INSTALLATION token → call the API with that. The JWT alone identifies the
 * App and can list installations; it cannot read a repository.
 */

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

/**
 * A JWT signed with the App's private key (RS256).
 *
 * `iat` is backdated 60s on purpose: GitHub rejects a token whose `iat` is
 * in the future, and a control plane whose clock is a few seconds fast
 * would otherwise fail every call with a 401 that says nothing about
 * clocks. `exp` stays under GitHub's 10-minute ceiling.
 */
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
  /** `https://github.com`, or a GitHub Enterprise host. */
  url: string;
}

/**
 * The REST API host for a given web host. On github.com the two differ;
 * on Enterprise the API lives under `/api/v3` of the same host.
 */
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
    // The body carries GitHub's own message, which is the only thing that
    // distinguishes "App not installed" from "private key wrong" — both 401.
    const detail = await response.text().catch(() => "");
    throw new GithubError(
      `GitHub responded ${response.status}: ${detail.slice(0, 300)}`,
      response.status
    );
  }
  return (await response.json()) as T;
}

export interface InstallationToken {
  /** Epoch millis. Short-lived by design — one hour at most. */
  expiresAt: number;
  token: string;
}

/**
 * Mint an installation token. NEVER cache this beyond `expiresAt`, and
 * never write it anywhere: it is a bearer credential for the user's
 * repositories.
 */
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

export interface GithubRepo {
  defaultBranch: string;
  /** `owner/name`. */
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

/** Every repository the installation can see, following pagination. */
export async function listRepositories(
  app: GithubApp,
  fetchImpl: GithubFetch = fetch
): Promise<GithubRepo[]> {
  const { token } = await installationToken(app, fetchImpl);
  const repos: GithubRepo[] = [];

  // Bounded rather than `while (true)`: a paginating loop against a remote
  // that keeps answering is how a deploy queue stops moving.
  for (let page = 1; page <= 20; page += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: pagination is inherently sequential — page N+1 is only known once N answered
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

/** Branch names of one repository, newest API page first. */
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

/**
 * The URL git clones with, carrying a fresh installation token.
 *
 * This is a SECRET that looks like a URL (ADR-0019): it must never reach a
 * deployment log, the `deployments` table, or the UI. It is built at the
 * moment of the clone and discarded.
 */
export function cloneUrlWithToken(repoUrl: string, token: string): string {
  const parsed = new URL(repoUrl);
  parsed.username = "x-access-token";
  parsed.password = token;
  return parsed.toString();
}

/** Everything before the credentials, for logs. */
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

// ─────────────────────────────────────────────────────────────────────────────
// App creation — the manifest flow
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What GitHub renders as a "create this App" form.
 *
 * The manifest is POSTed by the BROWSER to GitHub, not by us: it is the
 * operator's account that must own the App (ADR-0019). GitHub then sends
 * the browser back to `redirect_url` with a single-use `code`.
 */
export function appManifest(o: {
  /** Where GitHub sends webhooks. Must be reachable from GitHub. */
  webhookUrl: string;
  /** Where GitHub returns the browser, carrying `?code=`. */
  redirectUrl: string;
  name: string;
  /** The dashboard's own origin. */
  url: string;
}): Record<string, unknown> {
  return {
    // `checks: read` is not requested: Noddle deploys, it does not report
    // build status back. Ask for the minimum — an App's permissions are
    // what the operator is shown before approving.
    default_events: ["push", "pull_request"],
    default_permissions: { contents: "read", metadata: "read" },
    hook_attributes: { active: true, url: o.webhookUrl },
    name: o.name,
    public: false,
    redirect_url: o.redirectUrl,
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

/**
 * Exchange the manifest `code` for the App's credentials.
 *
 * SINGLE USE and short-lived: GitHub invalidates the code within an hour
 * and on first use. A failure here is unrecoverable by retrying the same
 * code — the operator has to start the manifest over, which is why the
 * error has to say so rather than read as a transient fault.
 */
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
    // GitHub returns a number; every later use is a JWT `iss` claim and a
    // path segment, both strings.
    appId: String(body.id),
    clientId: body.client_id,
    clientSecret: body.client_secret,
    htmlUrl: body.html_url,
    name: body.name,
    pem: body.pem,
    webhookSecret: body.webhook_secret,
  };
}

/** Where the operator installs the App they just created. */
export function installUrl(htmlUrl: string): string {
  return `${htmlUrl.replace(TRAILING_SLASHES, "")}/installations/new`;
}
