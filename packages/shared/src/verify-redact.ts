// bun run packages/shared/src/verify-redact.ts
//
// A deployment log is written to disk AND streamed to the dashboard. If a
// token survives this function, it survives in both.
import { check, runVerify } from "@noddle/testing";
import { redactUrlCredentials } from "#redact";

const TOKEN = "ghs_16C7e42F292c6912E7710c838347Ae178B4a";

await runVerify("url credential redaction", () => {
  const cloneUrl = `https://x-access-token:${TOKEN}@github.com/org/app.git`;

  check(
    "the token goes, the repository stays readable",
    redactUrlCredentials(cloneUrl) === "https://***@github.com/org/app.git"
  );

  check(
    "git echoes the URL inside its own messages",
    !redactUrlCredentials(
      `fatal: could not read Username for '${cloneUrl}': No such device`
    ).includes(TOKEN)
  );

  check(
    "several URLs in one chunk are all scrubbed",
    !redactUrlCredentials(
      `Cloning ${cloneUrl}\nSubmodule ${cloneUrl}\n`
    ).includes(TOKEN)
  );

  // GitLab's form (ADR-0019) — different username, same shape.
  check(
    "oauth2 user form is covered",
    redactUrlCredentials(`https://oauth2:${TOKEN}@gitlab.com/org/app.git`) ===
      "https://***@gitlab.com/org/app.git"
  );

  check(
    "a token as bare userinfo, with no password, is covered",
    redactUrlCredentials(`https://${TOKEN}@github.com/org/app.git`) ===
      "https://***@github.com/org/app.git"
  );

  check(
    "ssh remotes are covered too",
    redactUrlCredentials(`ssh://user:${TOKEN}@git.acme.io/app.git`) ===
      "ssh://***@git.acme.io/app.git"
  );

  // What must NOT be mangled: an ordinary log line is the common case, and
  // over-redacting makes logs useless.
  check(
    "a URL without credentials is untouched",
    redactUrlCredentials("https://github.com/org/app.git") ===
      "https://github.com/org/app.git"
  );

  check(
    "an email address is not a URL credential",
    redactUrlCredentials("author: jane@example.com") ===
      "author: jane@example.com"
  );

  check(
    "ordinary build output passes through",
    redactUrlCredentials("#8 [4/6] RUN npm ci\n#8 DONE 12.3s\n") ===
      "#8 [4/6] RUN npm ci\n#8 DONE 12.3s\n"
  );

  check("empty input stays empty", redactUrlCredentials("") === "");
});
