// tier: pure
// bun run packages/git-provider-credentials/src/verify.ts
import { encryptSecret, loadAppKey, secretContext } from "@noddle/crypto";
import { check, expectThrows, runVerify } from "@noddle/testing";

import { githubAppFromRow, githubAppWithInstallation, gitlabAppFromRow } from "./index.ts";

const KEY = loadAppKey(Buffer.alloc(32).toString("base64"));
const PROVIDER_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_ID = "22222222-2222-2222-2222-222222222222";
const PEM = "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----";
const CLIENT_SECRET = "gloas-not-a-real-secret";

const githubRow = {
  appId: "12345",
  installationId: "678",
  privateKeyEncrypted: encryptSecret(
    PEM,
    KEY,
    secretContext.gitProvider(PROVIDER_ID, "private_key"),
  ),
  url: "https://github.com",
};

const gitlabRow = {
  accessTokenEncrypted: null,
  applicationId: "app-1",
  expiresAt: null,
  redirectUri: "https://noddle.test/api/git-providers/gitlab/callback",
  refreshTokenEncrypted: null,
  secretEncrypted: encryptSecret(
    CLIENT_SECRET,
    KEY,
    secretContext.gitProvider(PROVIDER_ID, "client_secret"),
  ),
  url: "https://gitlab.com",
};

await runVerify("git-provider-credentials", () => {
  // ── GitHub ────────────────────────────────────────────────────────────
  const app = githubAppFromRow(KEY, PROVIDER_ID, githubRow);
  check("maps app id and url", app.appId === "12345" && app.url === "https://github.com");
  check("decrypts the App private key", app.privateKeyPem === PEM);

  // The AAD binds the ciphertext to ITS connection: a row moved or copied
  // between connections must not decrypt under the other one's id.
  expectThrows("a different connection id refuses to decrypt", () =>
    githubAppFromRow(KEY, OTHER_ID, githubRow),
  );

  expectThrows("an App that was never created is refused", () =>
    githubAppFromRow(KEY, PROVIDER_ID, {
      ...githubRow,
      appId: null,
    }),
  );

  const installed = githubAppWithInstallation(KEY, PROVIDER_ID, "acme", githubRow);
  check("carries the installation id", installed.installationId === "678");

  // The two refusals are distinct on purpose: they send the operator to
  // different screens, so each is asserted on its own wording.
  expectThrows(
    "an App created but not installed says so",
    () =>
      githubAppWithInstallation(KEY, PROVIDER_ID, "acme", {
        ...githubRow,
        installationId: null,
      }),
    (err) => err instanceof Error && err.message.includes("not installed"),
  );
  expectThrows(
    "an absent App says it was never created",
    () =>
      githubAppWithInstallation(KEY, PROVIDER_ID, "acme", {
        ...githubRow,
        appId: null,
      }),
    (err) => err instanceof Error && err.message.includes("never created"),
  );

  // ── GitLab ────────────────────────────────────────────────────────────
  const gitlab = gitlabAppFromRow(KEY, PROVIDER_ID, "acme", gitlabRow);
  check("decrypts the application secret", gitlab.secret === CLIENT_SECRET);
  check(
    "maps application id, redirect uri and url",
    gitlab.applicationId === "app-1" &&
      gitlab.redirectUri === gitlabRow.redirectUri &&
      gitlab.url === "https://gitlab.com",
  );

  // Same AAD binding as the GitHub half, under a different field name.
  expectThrows("a different connection id refuses the secret", () =>
    gitlabAppFromRow(KEY, OTHER_ID, "acme", gitlabRow),
  );

  expectThrows("an application missing its redirect uri is refused", () =>
    gitlabAppFromRow(KEY, PROVIDER_ID, "acme", {
      ...gitlabRow,
      redirectUri: null,
    }),
  );
});
