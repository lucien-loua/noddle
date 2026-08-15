// bun run packages/git-provider/src/verify-github.ts
//
// Pure: no network, no GitHub App. `fetch` is injected. What matters here
// is the JWT shape GitHub rejects silently, and that a token never leaks
// into something loggable.
import { generateKeyPairSync } from "node:crypto";
import { check, expectThrowsAsync, runVerify } from "@noddle/testing";
import {
  apiBase,
  appJwt,
  appManifest,
  cloneUrlWithToken,
  exchangeManifestCode,
  GithubError,
  installationToken,
  installUrl,
  listRepositories,
  redactCloneUrl,
} from "#github";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ format: "pem", type: "pkcs8" }).toString();

const APP = {
  appId: "12345",
  installationId: "678",
  privateKeyPem: PEM,
  url: "https://github.com",
};

const BASE64_UNSAFE = /[+/=]/;

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

await runVerify("github app", async () => {
  // ── the JWT ──────────────────────────────────────────────────────────
  const token = appJwt(APP.appId, PEM, Date.UTC(2026, 0, 1, 12, 0, 0));
  const [header, payload, signature] = token.split(".");

  check("the JWT has three segments", Boolean(header && payload && signature));

  check(
    "it is RS256 — GitHub rejects anything else",
    decodeSegment(header ?? "").alg === "RS256"
  );

  const claims = decodeSegment(payload ?? "");
  const iat = claims.iat as number;
  const exp = claims.exp as number;
  const nowSeconds = Date.UTC(2026, 0, 1, 12, 0, 0) / 1000;

  // A control plane whose clock runs a few seconds fast would otherwise
  // get a 401 on every call, saying nothing about clocks.
  check("iat is backdated, never in the future", iat < nowSeconds);

  check(
    "exp stays under GitHub's 10 minute ceiling",
    exp > iat && exp - iat <= 600
  );

  check("iss is the app id", claims.iss === APP.appId);

  check(
    "base64url — a JWT with + / or = is rejected",
    !BASE64_UNSAFE.test(token) && token.includes(".")
  );

  // ── the API host ─────────────────────────────────────────────────────
  check(
    "github.com uses api.github.com",
    apiBase("https://github.com") === "https://api.github.com" &&
      apiBase("https://github.com/") === "https://api.github.com"
  );

  check(
    "Enterprise keeps its host under /api/v3",
    apiBase("https://git.acme.io") === "https://git.acme.io/api/v3"
  );

  // ── the clone URL is a secret ────────────────────────────────────────
  const cloneUrl = cloneUrlWithToken(
    "https://github.com/org/app.git",
    "ghs_secrettoken"
  );

  check(
    "the token is embedded for git",
    cloneUrl.includes("x-access-token") && cloneUrl.includes("ghs_secrettoken")
  );

  check(
    "redaction removes it — this is what may be logged",
    !redactCloneUrl(cloneUrl).includes("ghs_secrettoken") &&
      redactCloneUrl(cloneUrl).includes("github.com/org/app.git")
  );

  check(
    "an unparseable URL redacts to a placeholder, never to itself",
    redactCloneUrl("ghs_secret@@@not a url") === "<repository>"
  );
  // ── minting a token ──────────────────────────────────────────────────
  let seenUrl = "";
  let seenAuth = "";
  const minted = await installationToken(APP, (url, init) => {
    seenUrl = url;
    seenAuth = String(
      (init?.headers as Record<string, string> | undefined)?.Authorization
    );
    return Promise.resolve(
      jsonResponse({
        expires_at: "2026-01-01T13:00:00Z",
        token: "ghs_installation",
      })
    );
  });

  check(
    "it posts to the installation's access_tokens endpoint",
    seenUrl === "https://api.github.com/app/installations/678/access_tokens"
  );

  check(
    "the JWT authenticates the mint, not the repository call",
    seenAuth.startsWith("Bearer ey")
  );

  check(
    "expiry is kept — the token must not outlive it",
    minted.token === "ghs_installation" &&
      minted.expiresAt === Date.parse("2026-01-01T13:00:00Z")
  );

  // ── a failure says what GitHub said ──────────────────────────────────
  await expectThrowsAsync(
    "a 401 surfaces GitHub's own message",
    () =>
      installationToken(APP, () =>
        Promise.resolve(
          jsonResponse(
            { message: "A JSON web token could not be decoded" },
            401
          )
        )
      ),
    (e) =>
      e instanceof GithubError &&
      e.status === 401 &&
      e.message.includes("could not be decoded")
  );

  // ── pagination terminates ────────────────────────────────────────────
  let calls = 0;
  const repos = await listRepositories(APP, (url) => {
    if (url.includes("access_tokens")) {
      return Promise.resolve(
        jsonResponse({ expires_at: "2026-01-01T13:00:00Z", token: "ghs_x" })
      );
    }
    calls += 1;
    // A remote that always answers a full page must not spin forever.
    return Promise.resolve(
      jsonResponse({
        repositories: Array.from({ length: 100 }, (_, i) => ({
          clone_url: `https://github.com/org/r${calls}-${i}.git`,
          default_branch: "main",
          full_name: `org/r${calls}-${i}`,
          private: true,
        })),
      })
    );
  });

  check(
    "a remote that never stops paginating is bounded",
    calls === 20 && repos.length === 2000
  );

  // ── the manifest ─────────────────────────────────────────────────────
  const manifest = appManifest({
    name: "noddle-acme",
    redirectUrl: "https://noddle.acme.io/api/git-providers/github/callback",
    url: "https://noddle.acme.io",
    webhookUrl: "https://noddle.acme.io/api/webhooks/github",
  });

  check(
    "it asks for the minimum — contents and metadata, read only",
    JSON.stringify(manifest.default_permissions) ===
      JSON.stringify({ contents: "read", metadata: "read" })
  );

  check(
    "push and pull_request, because previews need the second",
    JSON.stringify(manifest.default_events) ===
      JSON.stringify(["push", "pull_request"])
  );

  check(
    "the App is private — it is the operator's, not a listing",
    manifest.public === false
  );

  check(
    "the webhook is active from creation, not a later manual step",
    JSON.stringify(manifest.hook_attributes) ===
      JSON.stringify({
        active: true,
        url: "https://noddle.acme.io/api/webhooks/github",
      })
  );

  // ── the code exchange ────────────────────────────────────────────────
  let exchangeUrl = "";
  const created = await exchangeManifestCode(
    "abc123",
    "https://github.com",
    (url, init) => {
      exchangeUrl = `${init?.method} ${url}`;
      return Promise.resolve(
        jsonResponse({
          client_id: "Iv1.deadbeef",
          client_secret: "shhh",
          html_url: "https://github.com/apps/noddle-acme",
          id: 987_654,
          name: "noddle-acme",
          pem: "-----BEGIN RSA PRIVATE KEY-----\n",
          webhook_secret: "whsec",
        })
      );
    }
  );

  check(
    "the code is exchanged by POST at the conversions endpoint",
    exchangeUrl ===
      "POST https://api.github.com/app-manifests/abc123/conversions"
  );

  check(
    "the numeric app id becomes a string — it is a JWT claim and a path",
    created.appId === "987654" && typeof created.appId === "string"
  );

  check(
    "the private key and webhook secret are carried back",
    created.pem.startsWith("-----BEGIN") && created.webhookSecret === "whsec"
  );

  check(
    "the install URL is derived from the App page",
    installUrl(created.htmlUrl) ===
      "https://github.com/apps/noddle-acme/installations/new" &&
      installUrl("https://github.com/apps/x/") ===
        "https://github.com/apps/x/installations/new"
  );
});
