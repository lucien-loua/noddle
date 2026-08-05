// La lecture des charges utiles de pull request, éprouvée sur les deux formes
// que GitHub et GitLab documentent.
//
//   bun run apps/web/src/verify-webhook-payloads.ts
//
// Pur : aucune base, aucune VM. Ce qui compte ici n'est pas qu'une PR ouverte
// soit reconnue — c'est que les cas de REFUS le soient, et en particulier la
// détection de fork. Une prévisualisation exécute le code d'une pull request
// avec les variables du service parent ; se tromper sur ce booléen-là, c'est
// remettre les secrets de production à quiconque ouvre une PR.
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
      base: { repo: { full_name: "moi/appli" } },
      head: {
        ref: "feature/x",
        repo: { full_name: sameRepo ? "moi/appli" : "quelquun/appli" },
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

// ── GitHub ─────────────────────────────────────────────────────────────────
for (const action of ["opened", "reopened", "synchronize"]) {
  const r = parseWebhookPullRequest(gh(action));
  check(
    r !== null && !r.closed && r.number === 42 && r.headBranch === "feature/x",
    `GitHub ${action} → PR 42, branche feature/x, vivante`,
    `GitHub ${action} → ${JSON.stringify(r)}`
  );
}

check(
  parseWebhookPullRequest(gh("closed"))?.closed === true,
  "GitHub closed → fermée",
  "GitHub closed n'a pas été lu comme une fermeture"
);

check(
  parseWebhookPullRequest(gh("opened", false))?.fromFork === true,
  "GitHub depuis un FORK → détecté (dépôts différents)",
  "un fork n'a PAS été détecté — les secrets partiraient dehors"
);

check(
  parseWebhookPullRequest(gh("opened"))?.fromFork === false,
  "GitHub même dépôt → pas un fork",
  "un dépôt identique a été vu comme un fork"
);

for (const action of ["labeled", "assigned", "edited", "review_requested"]) {
  check(
    parseWebhookPullRequest(gh(action)) === null,
    `GitHub ${action} → ignoré (ne change ni le code ni la PR)`,
    `GitHub ${action} aurait déclenché un déploiement`
  );
}

{
  // `head.repo` absent : le cas d'un fork dont le dépôt a été supprimé. Doit
  // compter comme un fork — se tromper dans ce sens ne coûte qu'une
  // prévisualisation en moins.
  const body = JSON.parse(gh("opened")) as {
    pull_request: { head: { repo?: unknown } };
  };
  body.pull_request.head.repo = undefined;
  check(
    parseWebhookPullRequest(JSON.stringify(body))?.fromFork === true,
    "GitHub sans head.repo → traité comme un fork (échoue du bon côté)",
    "un head.repo manquant n'a pas été traité comme un fork"
  );
}

// ── GitLab ─────────────────────────────────────────────────────────────────
for (const action of ["open", "reopen", "update"]) {
  const r = parseWebhookPullRequest(gl(action));
  check(
    r !== null && !r.closed && r.number === 42,
    `GitLab ${action} → MR 42, vivante`,
    `GitLab ${action} → ${JSON.stringify(r)}`
  );
}

for (const action of ["close", "merge"]) {
  check(
    parseWebhookPullRequest(gl(action))?.closed === true,
    `GitLab ${action} → fermée`,
    `GitLab ${action} n'a pas été lu comme une fermeture`
  );
}

check(
  parseWebhookPullRequest(gl("open", false))?.fromFork === true,
  "GitLab projet source ≠ cible → fork détecté",
  "un fork GitLab n'a PAS été détecté"
);

// ── ce qui ne doit RIEN produire ───────────────────────────────────────────
const rejected: [string, string][] = [
  ["corps illisible", "pas du json"],
  [
    "push (l'autre événement)",
    JSON.stringify({ after: "abc", ref: "refs/heads/main" }),
  ],
  ["objet vide", "{}"],
  [
    "pull_request sans head",
    JSON.stringify({ action: "opened", pull_request: {} }),
  ],
];
for (const [label, raw] of rejected) {
  check(
    parseWebhookPullRequest(raw) === null,
    `${label} → null`,
    `${label} a produit une PR`
  );
}

console.log(`\n\x1b[1m${pass} réussis, ${fail} échoués\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
