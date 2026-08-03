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
