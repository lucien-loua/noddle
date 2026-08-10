//   bun run apps/web/src/verify-webhook-payloads.ts
//
// Pure: no database, no VM. What matters here isn't that an open PR gets
// recognized — it's that REFUSAL cases are, especially fork detection. A
// preview runs a pull request's code with the parent service's variables;
// getting that boolean wrong hands production secrets to anyone who opens
// a PR.
import { parseWebhookPullRequest } from "@/lib/webhook.server";

let pass = 0;
let fail = 0;
const ok = (m: string) => {
  pass += 1;
  console.log(`  \x1b[32m✓\x1b[0m ${m}`);
};
const ko = (m: string) => {
  fail += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${m}`);
};
const check = (condition: boolean, good: string, bad: string) => {
  if (condition) {
    ok(good);
  } else {
    ko(bad);
  }
};

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

// ── GitHub ───────────────────────────────────────────────────────────────
for (const action of ["opened", "reopened", "synchronize"]) {
  const r = parseWebhookPullRequest(gh(action));
  check(
    r !== null && !r.closed && r.number === 42 && r.headBranch === "feature/x",
    `GitHub ${action} → PR 42, branch feature/x, alive`,
    `GitHub ${action} → ${JSON.stringify(r)}`
  );
}

check(
  parseWebhookPullRequest(gh("closed"))?.closed === true,
  "GitHub closed → closed",
  "GitHub closed was not read as a closure"
);

check(
  parseWebhookPullRequest(gh("opened", false))?.fromFork === true,
  "GitHub from a FORK → detected (different repos)",
  "a fork was NOT detected — secrets would leak out"
);

check(
  parseWebhookPullRequest(gh("opened"))?.fromFork === false,
  "GitHub same repo → not a fork",
  "an identical repo was seen as a fork"
);

for (const action of ["labeled", "assigned", "edited", "review_requested"]) {
  check(
    parseWebhookPullRequest(gh(action)) === null,
    `GitHub ${action} → ignored (changes neither the code nor the PR)`,
    `GitHub ${action} would have triggered a deployment`
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
    parseWebhookPullRequest(JSON.stringify(body))?.fromFork === true,
    "GitHub with no head.repo → treated as a fork (fails on the safe side)",
    "a missing head.repo was not treated as a fork"
  );
}

// ── GitLab ───────────────────────────────────────────────────────────────
for (const action of ["open", "reopen", "update"]) {
  const r = parseWebhookPullRequest(gl(action));
  check(
    r !== null && !r.closed && r.number === 42,
    `GitLab ${action} → MR 42, alive`,
    `GitLab ${action} → ${JSON.stringify(r)}`
  );
}

for (const action of ["close", "merge"]) {
  check(
    parseWebhookPullRequest(gl(action))?.closed === true,
    `GitLab ${action} → closed`,
    `GitLab ${action} was not read as a closure`
  );
}

check(
  parseWebhookPullRequest(gl("open", false))?.fromFork === true,
  "GitLab source project ≠ target → fork detected",
  "a GitLab fork was NOT detected"
);

// ── what must produce NOTHING ───────────────────────────────────────────
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
    parseWebhookPullRequest(raw) === null,
    `${label} → null`,
    `${label} produced a PR`
  );
}

console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
