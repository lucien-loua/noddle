// tier: pure
import { check, runVerify } from "@noddle/testing";

import {
  parseWebhookPullRequest,
  parseWebhookPush,
  payloadRepository,
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
      push.files.includes("old/c.ts"),
    `got ${JSON.stringify(push?.files)}`
  );

  const bare = parseWebhookPush(
    JSON.stringify({ after: "abc123", ref: "refs/heads/main" })
  );
  check(
    "a push with no commits array is still a push, with no files",
    bare !== null && bare.branch === "main" && bare.files.length === 0,
    `got ${JSON.stringify(bare)}`
  );

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

  const ghBody = JSON.stringify({ repository: { full_name: "Org/App" } });
  const glBody = JSON.stringify({
    project: { path_with_namespace: "Group/Sub/App" },
  });

  check(
    "GitHub reads repository.full_name, lowercased",
    payloadRepository("github", ghBody) === "org/app"
  );
  check(
    "GitLab reads project.path_with_namespace, subgroups intact",
    payloadRepository("gitlab", glBody) === "group/sub/app"
  );
  check(
    "each forge reads its OWN field and not the other's",
    payloadRepository("github", glBody) === null &&
      payloadRepository("gitlab", ghBody) === null
  );
  check(
    "an unreadable body names nothing rather than throwing",
    payloadRepository("github", "{{") === null &&
      payloadRepository("gitlab", "[]") === null
  );

  check(
    "a GitLab subgroup payload matches its service",
    repositoryMatches(picked, payloadRepository("gitlab", glBody) ?? "")
  );
});
