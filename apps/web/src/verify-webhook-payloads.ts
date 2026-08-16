// bun run apps/web/src/verify-webhook-payloads.ts
//
// Pure: no database, no VM. What matters here isn't that an open PR gets
// recognized — it's that REFUSAL cases are, especially fork detection. A
// preview runs a pull request's code with the parent service's variables;
// getting that boolean wrong hands production secrets to anyone who opens
// a PR.
import { check, runVerify } from "@noddle/testing";
import {
  parseWebhookPullRequest,
  parseWebhookPush,
  repoSlug,
  repositoryMatches,
} from "@/lib/webhook.server";

const gh = (action: string, sameRepo = true) =>
  JSON.stringify({
    action,
    number: 42,
    pull_request: {
      base: { repo: { full_name: "me/app" } },
      head: {
        ref: "feature/x",
        repo: { full_name: sameRepo ? "me/app" : "someone/app" },
        sha: "abc123def456",
      },
      number: 42,
    },
  });

const gl = (action: string, sameProject = true) =>
  JSON.stringify({
    object_attributes: {
      action,
      iid: 42,
      last_commit: { id: "abc123def456" },
      source_branch: "feature/x",
      source_project_id: sameProject ? 7 : 9,
      target_project_id: 7,
    },
    object_kind: "merge_request",
  });

await runVerify("webhook payloads", () => {
  // ── GitHub ─────────────────────────────────────────────────────────────
  for (const action of ["opened", "reopened", "synchronize"]) {
    const r = parseWebhookPullRequest(gh(action));
    check(
      `GitHub ${action} → PR 42, branch feature/x, alive`,
      r !== null &&
        !r.closed &&
        r.number === 42 &&
        r.headBranch === "feature/x",
      `got ${JSON.stringify(r)}`
    );
  }

  check(
    "GitHub closed → closed",
    parseWebhookPullRequest(gh("closed"))?.closed === true,
    "not read as a closure"
  );

  check(
    "GitHub from a FORK → detected (different repos)",
    parseWebhookPullRequest(gh("opened", false))?.fromFork === true,
    "a fork was NOT detected — secrets would leak out"
  );

  check(
    "GitHub same repo → not a fork",
    parseWebhookPullRequest(gh("opened"))?.fromFork === false,
    "an identical repo was seen as a fork"
  );

  for (const action of ["labeled", "assigned", "edited", "review_requested"]) {
    check(
      `GitHub ${action} → ignored (changes neither the code nor the PR)`,
      parseWebhookPullRequest(gh(action)) === null,
      "would have triggered a deployment"
    );
  }

  {
    // `head.repo` missing: the case of a fork whose repository has been
    // deleted. Must count as a fork — erring in this direction only costs
    // one fewer preview.
    const body = JSON.parse(gh("opened")) as {
      pull_request: { head: { repo?: unknown } };
    };
    body.pull_request.head.repo = undefined;
    check(
      "GitHub with no head.repo → treated as a fork (fails on the safe side)",
      parseWebhookPullRequest(JSON.stringify(body))?.fromFork === true,
      "a missing head.repo was not treated as a fork"
    );
  }

  // ── GitLab ─────────────────────────────────────────────────────────────
  for (const action of ["open", "reopen", "update"]) {
    const r = parseWebhookPullRequest(gl(action));
    check(
      `GitLab ${action} → MR 42, alive`,
      r !== null && !r.closed && r.number === 42,
      `got ${JSON.stringify(r)}`
    );
  }

  for (const action of ["close", "merge"]) {
    check(
      `GitLab ${action} → closed`,
      parseWebhookPullRequest(gl(action))?.closed === true,
      "not read as a closure"
    );
  }

  check(
    "GitLab source project ≠ target → fork detected",
    parseWebhookPullRequest(gl("open", false))?.fromFork === true,
    "a GitLab fork was NOT detected"
  );

  // ── what must produce NOTHING ────────────────────────────────────────
  const rejected: [string, string][] = [
    ["unreadable body", "not json"],
    [
      "push (the other event)",
      JSON.stringify({ after: "abc", ref: "refs/heads/main" }),
    ],
    ["empty object", "{}"],
    [
      "pull_request with no head",
      JSON.stringify({ action: "opened", pull_request: {} }),
    ],
  ];
  for (const [label, raw] of rejected) {
    check(
      `${label} → null`,
      parseWebhookPullRequest(raw) === null,
      "produced a PR"
    );
  }

  // ── the file list a watch-path filter is applied to ──────────────────
  const push = parseWebhookPush(
    JSON.stringify({
      after: "abc123",
      commits: [
        { added: ["src/a.ts"], modified: ["README.md"], removed: [] },
        { added: [], modified: ["src/b.ts"], removed: ["old/c.ts"] },
      ],
      ref: "refs/heads/main",
    })
  );
  check(
    "a push lists every file it touched, across commits",
    push !== null &&
      push.files.length === 4 &&
      push.files.includes("src/a.ts") &&
      push.files.includes("src/b.ts") &&
      // A removal is a change: dropping the last file under a watched path
      // must still deploy.
      push.files.includes("old/c.ts"),
    `got ${JSON.stringify(push?.files)}`
  );

  // A push with no readable commits stays a valid push — the deploy
  // decision belongs to shouldDeployPaths, not to the parser.
  const bare = parseWebhookPush(
    JSON.stringify({ after: "abc123", ref: "refs/heads/main" })
  );
  check(
    "a push with no commits array is still a push, with no files",
    bare !== null && bare.branch === "main" && bare.files.length === 0,
    `got ${JSON.stringify(bare)}`
  );

  // ── matching a payload's repository to a stored clone URL ────────────
  // The App webhook says `owner/name`; a service stores whatever the user
  // pasted. Two spellings of one repository must not read as two.
  const spellings = [
    "https://github.com/Org/App.git",
    "https://github.com/Org/App",
    "https://github.com/Org/App/",
    "git@github.com:Org/App.git",
    "ssh://git@github.com/Org/App.git",
  ];
  check(
    "every spelling of one repository resolves to the same slug",
    spellings.every((u) => repoSlug(u) === "org/app"),
    `got ${JSON.stringify(spellings.map(repoSlug))}`
  );

  check(
    "a self-hosted host does not change the slug",
    repoSlug("https://git.acme.io/team/api.git") === "team/api"
  );

  check(
    "a nested GitLab-style group keeps the LAST two segments",
    repoSlug("https://gitlab.com/group/sub/app.git") === "sub/app"
  );

  check(
    "an unusable URL is null, never a partial match",
    repoSlug(null) === null &&
      repoSlug("") === null &&
      repoSlug("https://github.com/") === null &&
      repoSlug("nonsense") === null
  );

  // ── matching a payload's repository to a service ─────────────────────
  // The slug above is the FALLBACK. A service picked from a connection
  // stores the forge's own name, and that is what the payload carries.
  const picked = {
    gitRepoFullName: "group/sub/app",
    gitRepoUrl: "https://gitlab.com/group/sub/app.git",
  };
  const byUrl = {
    gitRepoFullName: null,
    gitRepoUrl: "https://gitlab.com/group/sub/app.git",
  };

  check(
    "a GitLab subgroup matches its path_with_namespace",
    repositoryMatches(picked, "group/sub/app"),
    "this is the comparison that silently stopped deploying"
  );
  check(
    "a subgroup service is NOT matched by the truncated slug",
    !repositoryMatches(picked, "sub/app")
  );
  check(
    "case and stray whitespace do not split one repository in two",
    repositoryMatches(picked, "  Group/Sub/App  ")
  );

  check(
    "a GitHub service matches its full_name",
    repositoryMatches(
      {
        gitRepoFullName: "org/app",
        gitRepoUrl: "https://github.com/Org/App.git",
      },
      "Org/App"
    )
  );

  // Without a stored name both sides reduce to a slug — reducing the
  // PAYLOAD too is what keeps the by-URL case symmetric.
  check(
    "a by-URL subgroup service still matches, via both sides reducing",
    repositoryMatches(byUrl, "group/sub/app")
  );
  check(
    "a by-URL service does not match a different repository",
    !repositoryMatches(byUrl, "group/sub/other")
  );
  check(
    "a service with neither name nor URL matches nothing",
    !repositoryMatches({ gitRepoFullName: null, gitRepoUrl: null }, "org/app")
  );
});
