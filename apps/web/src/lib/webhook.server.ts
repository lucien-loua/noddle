// Vérification et lecture d'un webhook de déploiement.
//
// Deux fournisseurs, un seul schéma de payload push (ref/after) — GitHub ET
// GitLab l'utilisent tel quel pour cet événement, seule la vérification
// diffère : GitHub signe le corps (HMAC-SHA256), GitLab envoie le secret en
// clair dans un en-tête. Comparaison à temps constant dans les deux cas —
// une différence de timing sur la comparaison serait un canal pour deviner
// le secret octet par octet.
import { createHmac, timingSafeEqual } from "node:crypto";

function timingSafeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // Une taille différente fuiterait déjà de l'information par `timingSafeEqual`
  // lui-même, qui exige des tampons de même longueur.
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export function verifyWebhookSignature(
  headers: Headers,
  rawBody: string,
  secret: string
): boolean {
  const githubSignature = headers.get("x-hub-signature-256");
  if (githubSignature) {
    const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
    return timingSafeCompare(expected, githubSignature);
  }

  const gitlabToken = headers.get("x-gitlab-token");
  if (gitlabToken) {
    return timingSafeCompare(gitlabToken, secret);
  }

  return false;
}

export interface WebhookPush {
  branch: string;
  commitSha: string | null;
}

/** `null` = payload illisible ou pas un push de branche (tag, suppression). */
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
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Pull requests — l'autre événement que ce même webhook porte
// ─────────────────────────────────────────────────────────────────────────────

export interface WebhookPullRequest {
  /** `true` quand la PR est fermée ou fusionnée : la prévisualisation part. */
  closed: boolean;
  commitSha: string;
  /**
   * La PR vient d'un FORK. Aucune prévisualisation ne sera créée.
   *
   * C'est le seul cas réellement dangereux de l'héritage des variables : une
   * prévisualisation exécute le code de la pull request, donc une PR venue de
   * l'extérieur avec les secrets de production peut les exfiltrer en trois
   * lignes. GitHub retient la même règle pour ses propres secrets.
   */
  fromFork: boolean;
  /** La branche de la PR, pas celle de destination. */
  headBranch: string;
  number: number;
}

/**
 * `null` = ce n'est pas un événement de pull request lisible.
 *
 * GitHub envoie `pull_request` avec une `action` ; GitLab envoie
 * `object_kind: "merge_request"` avec `object_attributes`. Contrairement au
 * push — où les deux partagent le MÊME schéma et où un seul lecteur suffit —
 * les charges utiles diffèrent ici, donc les deux formes sont lues
 * explicitement.
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
  // Toute autre action — `labeled`, `assigned`, `edited` — ne change ni le
  // code ni l'existence de la PR. Répondre 200 sans rien faire, plutôt que
  // reconstruire une prévisualisation identique à chaque étiquette posée.
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
    // Comparaison des dépôts, pas un drapeau : GitHub n'en fournit pas. Un
    // `full_name` manquant est traité comme un fork — se tromper dans ce
    // sens-là ne coûte qu'une prévisualisation en moins.
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
  // GitLab dit `merge` là où GitHub dit `closed` avec un drapeau : les deux
  // veulent dire « la prévisualisation n'a plus lieu d'être ».
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
    // GitLab expose directement les identifiants de projet source et cible.
    fromFork: attrs.source_project_id !== attrs.target_project_id,
    headBranch: attrs.source_branch,
    number: iid,
  };
}
