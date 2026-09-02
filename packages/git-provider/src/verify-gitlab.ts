// tier: pure
import { check, expectThrowsAsync, runVerify } from "@noddle/testing";

import {
  apiBase,
  authorizeUrl,
  cloneUrlWithToken,
  exchangeCode,
  GitlabError,
  listBranches,
  listProjects,
  needsRefresh,
  refreshTokens,
} from "#gitlab";

const APP = {
  applicationId: "app-123",
  redirectUri: "https://noddle.acme.io/api/git-providers/gitlab/callback",
  secret: "shhh",
  url: "https://gitlab.com",
};

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

await runVerify("gitlab oauth", async () => {
  const authorize = new URL(authorizeUrl(APP, "state-abc"));

  check(
    "state travels, since the callback has nothing else to identify the row",
    authorize.searchParams.get("state") === "state-abc"
  );

  check(
    "only read scopes are asked for",
    authorize.searchParams.get("scope") === "api read_repository"
  );

  check(
    "a self-hosted instance keeps its own host",
    authorizeUrl({ ...APP, url: "https://git.acme.io/" }, "s").startsWith(
      "https://git.acme.io/oauth/authorize"
    )
  );

  check(
    "the API lives under /api/v4 of the instance",
    apiBase("https://gitlab.com") === "https://gitlab.com/api/v4" &&
      apiBase("https://git.acme.io/") === "https://git.acme.io/api/v4"
  );

  let seen = "";
  const tokens = await exchangeCode(
    APP,
    "code-1",
    (url, init) => {
      seen = `${init?.method} ${url}`;
      return Promise.resolve(
        jsonResponse({
          access_token: "at-1",
          expires_in: 7200,
          refresh_token: "rt-1",
        })
      );
    },
    NOW
  );

  check(
    "the code is exchanged at the instance's token endpoint",
    seen === "POST https://gitlab.com/oauth/token"
  );

  check(
    "expiry is stored as an instant, not a duration",
    tokens.expiresAt === NOW + 7_200_000 && tokens.accessToken === "at-1"
  );

  check(
    "a token with time left is not refreshed",
    !needsRefresh(NOW + 600_000, NOW)
  );

  check(
    "a token about to expire IS refreshed — the margin is the point",
    needsRefresh(NOW + 30_000, NOW),
    "a clone starting now would outlive the token"
  );

  check("an expired token is refreshed", needsRefresh(NOW - 1, NOW));

  check(
    "a connection that never had a token refreshes rather than assuming",
    needsRefresh(null, NOW)
  );

  const renewed = await refreshTokens(
    APP,
    "rt-1",
    () =>
      Promise.resolve(
        jsonResponse({
          access_token: "at-2",
          expires_in: 7200,
          refresh_token: "rt-2",
        })
      ),
    NOW
  );

  check(
    "the rotated refresh token is the one kept",
    renewed.refreshToken === "rt-2" && renewed.accessToken === "at-2"
  );

  await expectThrowsAsync(
    "a refused refresh surfaces GitLab's own message",
    () =>
      refreshTokens(APP, "stale", () =>
        Promise.resolve(jsonResponse({ error: "invalid_grant" }, 400))
      ),
    (e) => e instanceof GitlabError && e.status === 400
  );

  const repos = await listProjects("https://gitlab.com", "at-2", () =>
    Promise.resolve(
      jsonResponse([
        {
          default_branch: "trunk",
          http_url_to_repo: "https://gitlab.com/acme/api.git",
          path_with_namespace: "acme/api",
        },
      ])
    )
  );
  check(
    "a project keeps its own default branch",
    repos.length === 1 &&
      repos[0]?.fullName === "acme/api" &&
      repos[0]?.defaultBranch === "trunk"
  );

  let branchUrl = "";
  await listBranches("https://gitlab.com", "at-2", "acme/sub/api", (url) => {
    branchUrl = url;
    return Promise.resolve(jsonResponse([{ name: "main" }]));
  });
  check(
    "a nested project path is URL-encoded",
    branchUrl.includes("acme%2Fsub%2Fapi")
  );

  check(
    "the token is embedded as the oauth2 user",
    cloneUrlWithToken("https://gitlab.com/acme/api.git", "at-2") ===
      "https://oauth2:at-2@gitlab.com/acme/api.git"
  );
});
