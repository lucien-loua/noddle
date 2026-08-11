// bun run apps/web/src/verify-webhook-payloads.ts
//
// Pure: no database, no VM. What matters here isn't that an open PR gets
// recognized — it's that REFUSAL cases are, especially fork detection. A
// preview runs a pull request's code with the parent service's variables;
// getting that boolean wrong hands production secrets to anyone who opens
// a PR.
import { check, runVerify } from "@noddle/shared/verify-harness";
import { parseWebhookPullRequest } from "@/lib/webhook.server";

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
});
