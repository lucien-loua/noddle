// Vérifie qu'AUCUNE server function mutante n'est sans garde.
//
//   bun run apps/web/src/verify-permissions.ts
//
// C'est la réponse au problème central de ce chantier : **un contrôle de
// permission absent est invisible.** Une fonction ajoutée sans garde ne lève
// rien, ne casse rien, et laisse un trou que personne ne remarque avant qu'il
// serve. On ne peut pas voir ce qui manque — alors on le calcule.
//
// La vérification lit les FICHIERS, pas une liste tenue à la main : elle
// énumère chaque `createServerFn({ method: "POST" })` du dossier `server/` et
// exige que son corps appelle `requirePermission`. Ajouter demain une
// fonction mutante sans garde fera échouer ce script, ce qu'aucun typecheck
// ne ferait.
//
// Elle vérifie aussi le sens inverse, qui est le piège moins évident : une
// permission qui n'existe pas dans le modèle (`server: ["deploy"]`) est
// refusée par le TYPE, mais une permission trop FAIBLE ne l'est par rien.
// D'où le contrôle des couples sensibles, écrits ici en toutes lettres.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { deployer, viewer } from "@/lib/permissions";

const SERVER_DIR = join(import.meta.dirname, "server");

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

/** Le corps d'une déclaration `export const <nom> = createServerFn(...)`,
 *  jusqu'à la déclaration suivante. Suffisant : ces fichiers n'imbriquent pas
 *  de server functions. */
function declarations(source: string): { body: string; name: string }[] {
  const out: { body: string; name: string }[] = [];
  const re = /export const (\w+) = createServerFn\(\{ method: "(\w+)" \}\)/g;
  const found = [...source.matchAll(re)];

  for (const [index, match] of found.entries()) {
    if (match[2] !== "POST") {
      continue;
    }
    const start = match.index;
    const end = found[index + 1]?.index ?? source.length;
    out.push({ body: source.slice(start, end), name: match[1] ?? "?" });
  }
  return out;
}

console.log("\n\x1b[1mGardes de permission sur les server functions\x1b[0m");

const files = readdirSync(SERVER_DIR).filter((f) => f.endsWith(".ts"));
const unguarded: string[] = [];
let mutating = 0;

for (const file of files) {
  const source = readFileSync(join(SERVER_DIR, file), "utf8");
  for (const decl of declarations(source)) {
    mutating += 1;
    if (!decl.body.includes("requirePermission(")) {
      unguarded.push(`${file}:${decl.name}`);
    }
  }
}

if (mutating === 0) {
  ko("aucune server function mutante trouvée — la détection est cassée");
} else {
  ok(`${mutating} server functions mutantes énumérées`);
}

if (unguarded.length === 0) {
  ok("toutes déclarent une permission");
} else {
  ko(`SANS GARDE : ${unguarded.join(", ")}`);
}

// ── Les couples sensibles, écrits en toutes lettres ────────────────────────
// Un rôle trop permissif ne casse rien et ne se voit pas. Ces assertions
// existent pour que l'affaiblir demande de MODIFIER un test, pas de l'oublier.

const cases: [string, boolean, string][] = [
  [
    "un lecteur ne peut pas déployer",
    viewer.authorize({ service: ["deploy"] }).success,
    "false",
  ],
  [
    "un lecteur ne peut pas lire les variables d'environnement",
    viewer.authorize({ envVar: ["read"] }).success,
    "false",
  ],
  [
    "un opérateur peut déployer",
    deployer.authorize({ service: ["deploy"] }).success,
    "true",
  ],
  [
    "un opérateur ne peut PAS restaurer une sauvegarde",
    deployer.authorize({ backup: ["restore"] }).success,
    "false",
  ],
  [
    "un opérateur ne peut PAS lire les secrets",
    deployer.authorize({ envVar: ["read"] }).success,
    "false",
  ],
  [
    "un opérateur ne peut PAS supprimer un serveur",
    deployer.authorize({ server: ["delete"] }).success,
    "false",
  ],
  [
    "un opérateur ne peut PAS supprimer un service",
    deployer.authorize({ service: ["delete"] }).success,
    "false",
  ],
];

for (const [label, actual, expected] of cases) {
  if (String(actual) === expected) {
    ok(label);
  } else {
    ko(`${label} — obtenu ${actual}`);
  }
}

console.log(`\n\x1b[1mréussis ${pass}, échoués ${fail}\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
