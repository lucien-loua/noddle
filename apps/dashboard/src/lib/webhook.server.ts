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
    for (const list of [added, modified, removed]) {
      if (Array.isArray(list)) {
        files.push(...list.filter((f) => typeof f === "string"));
      }
    }
  }
  return files;
}

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

export interface WebhookPullRequest {
  closed: boolean;
  commitSha: string;
  fromFork: boolean;
  headBranch: string;
  number: number;
}

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
    fromFork: attrs.source_project_id !== attrs.target_project_id,
    headBranch: attrs.source_branch,
    number: iid,
  };
}

const URL_SCHEME = /^[a-z]+:\/\/[^/]+\//i;
const SSH_PREFIX = /^git@[^:]+:/i;
const DOT_GIT = /\.git$/i;

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

export function payloadRepository(
  forge: "github" | "gitlab",
  rawBody: string
): string | null {
  try {
    const body = JSON.parse(rawBody) as {
      project?: { path_with_namespace?: unknown };
      repository?: { full_name?: unknown };
    };
    const named =
      forge === "gitlab"
        ? body.project?.path_with_namespace
        : body.repository?.full_name;
    return typeof named === "string" ? named.toLowerCase() : null;
  } catch {
    return null;
  }
}

export function repositoryMatches(
  service: { gitRepoFullName: string | null; gitRepoUrl: string | null },
  repository: string
): boolean {
  const full = service.gitRepoFullName?.trim().toLowerCase();
  if (full) {
    return full === repository.trim().toLowerCase();
  }
  const slug = repoSlug(service.gitRepoUrl);
  return slug !== null && slug === repoSlug(repository);
}
