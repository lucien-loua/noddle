import { createHmac } from "node:crypto";
import { safeEqual } from "@noddle/crypto";

export function verifyWebhookSignature(
  headers: Headers,
  rawBody: string,
  secret: string
): boolean {
  const githubSignature = headers.get("x-hub-signature-256");
  if (githubSignature) {
    const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
    return safeEqual(expected, githubSignature);
  }

  const gitlabToken = headers.get("x-gitlab-token");
  if (gitlabToken) {
    return safeEqual(gitlabToken, secret);
  }

  return false;
}

export interface WebhookPush {
  branch: string;
  commitSha: string | null;
  /** Every file the push touched, across all its commits. */
  files: string[];
}

function pushedFiles(payload: Record<string, unknown>): string[] {
  const { commits } = payload;
  if (!Array.isArray(commits)) {
    return [];
  }
  const files: string[] = [];
  for (const commit of commits) {
    if (typeof commit !== "object" || commit === null) {
      continue;
    }
    const { added, modified, removed } = commit as Record<string, unknown>;
    // A removal is a change: deleting the last file under a watched path
    // must still deploy.
    for (const list of [added, modified, removed]) {
      if (Array.isArray(list)) {
        files.push(...list.filter((f) => typeof f === "string"));
      }
    }
  }
  return files;
}

/** `null` = unreadable payload or not a branch push (tag, deletion). */
export function parseWebhookPush(rawBody: string): WebhookPush | null {
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) {
    return null;
  }

  const { ref, after } = payload as Record<string, unknown>;
  if (typeof ref !== "string" || !ref.startsWith("refs/heads/")) {
    return null;
  }

  return {
    branch: ref.slice("refs/heads/".length),
    commitSha: typeof after === "string" ? after : null,
    files: pushedFiles(payload as Record<string, unknown>),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Pull requests — the other event this same webhook carries
// ─────────────────────────────────────────────────────────────────────────────

export interface WebhookPullRequest {
  /** `true` when the PR is closed or merged: the preview goes away. */
  closed: boolean;
  commitSha: string;
  /**
   * The PR comes from a FORK. No preview will be created.
   *
   * This is the only genuinely dangerous case of variable inheritance: a
   * preview runs the pull request's code, so a PR coming from outside
   * with production secrets could exfiltrate them in three lines. GitHub
   * follows the same rule for its own secrets.
   */
  fromFork: boolean;
  /** The PR's branch, not the destination one. */
  headBranch: string;
  number: number;
}

/**
 * `null` = this is not a readable pull request event.
 *
 * GitHub sends `pull_request` with an `action`; GitLab sends
 * `object_kind: "merge_request"` with `object_attributes`. Unlike the
 * push event — where both share the SAME schema and a single reader is
 * enough — the payloads differ here, so both shapes are read explicitly.
 */
export function parseWebhookPullRequest(
  rawBody: string
): WebhookPullRequest | null {
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const body = payload as Record<string, unknown>;

  return body.object_kind === "merge_request"
    ? parseGitlabMergeRequest(body)
    : parseGithubPullRequest(body);
}

const GITHUB_LIVE_ACTIONS = new Set(["opened", "reopened", "synchronize"]);

function parseGithubPullRequest(
  body: Record<string, unknown>
): WebhookPullRequest | null {
  const { action, pull_request: pr } = body as {
    action?: unknown;
    pull_request?: Record<string, unknown>;
  };
  if (typeof action !== "string" || !pr) {
    return null;
  }
  // Any other action — `labeled`, `assigned`, `edited` — changes neither
  // the code nor the PR's existence. Respond 200 and do nothing, rather
  // than rebuilding an identical preview on every label added.
  if (!(GITHUB_LIVE_ACTIONS.has(action) || action === "closed")) {
    return null;
  }

  const head = pr.head as Record<string, unknown> | undefined;
  const base = pr.base as Record<string, unknown> | undefined;
  const headRepo = head?.repo as Record<string, unknown> | undefined;
  const baseRepo = base?.repo as Record<string, unknown> | undefined;
  const number = body.number ?? pr.number;

  if (
    typeof number !== "number" ||
    typeof head?.sha !== "string" ||
    typeof head.ref !== "string"
  ) {
    return null;
  }

  return {
    closed: action === "closed",
    commitSha: head.sha,
    // Comparing repositories, not a flag: GitHub doesn't provide one. A
    // missing `full_name` is treated as a fork — erring in that direction
    // only costs one fewer preview.
    fromFork:
      typeof headRepo?.full_name !== "string" ||
      typeof baseRepo?.full_name !== "string" ||
      headRepo.full_name !== baseRepo.full_name,
    headBranch: head.ref,
    number,
  };
}

const GITLAB_LIVE_ACTIONS = new Set(["open", "reopen", "update"]);

function parseGitlabMergeRequest(
  body: Record<string, unknown>
): WebhookPullRequest | null {
  const attrs = body.object_attributes as Record<string, unknown> | undefined;
  if (!attrs) {
    return null;
  }
  const { action } = attrs;
  if (typeof action !== "string") {
    return null;
  }
  // GitLab says `merge` where GitHub says `closed` with a flag: both
  // mean "the preview no longer has a reason to exist".
  const closed = action === "close" || action === "merge";
  if (!(GITLAB_LIVE_ACTIONS.has(action) || closed)) {
    return null;
  }

  const { iid, last_commit: lastCommit } = attrs as {
    iid?: unknown;
    last_commit?: Record<string, unknown>;
  };
  if (typeof iid !== "number" || typeof attrs.source_branch !== "string") {
    return null;
  }
  const sha = lastCommit?.id;
  if (typeof sha !== "string") {
    return null;
  }

  return {
    closed,
    commitSha: sha,
    // GitLab exposes the source and target project identifiers directly.
    fromFork: attrs.source_project_id !== attrs.target_project_id,
    headBranch: attrs.source_branch,
    number: iid,
  };
}

const URL_SCHEME = /^[a-z]+:\/\/[^/]+\//i;
const SSH_PREFIX = /^git@[^:]+:/i;
const DOT_GIT = /\.git$/i;

/**
 * `owner/name` out of a clone URL, however it was written.
 *
 * The App's webhook identifies a repository by `full_name`, while a service
 * stores whatever URL the user pasted: https or ssh, with or without
 * `.git`, with or without a trailing slash. Two spellings of one repository
 * must not read as two different ones — that would silently stop deploying
 * a service whose URL is merely written differently.
 */
export function repoSlug(url: string | null | undefined): string | null {
  if (!url) {
    return null;
  }
  const path = url
    .trim()
    .replace(URL_SCHEME, "")
    .replace(SSH_PREFIX, "")
    .replace(DOT_GIT, "");
  const parts = path.split("/").filter(Boolean);
  if (parts.length < 2) {
    return null;
  }
  return `${parts.at(-2)}/${parts.at(-1)}`.toLowerCase();
}
