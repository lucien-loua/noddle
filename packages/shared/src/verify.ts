// Vérifie les propriétés du chiffrement des secrets.
//
// Un aller-retour réussi ne prouve presque rien : du base64 le ferait aussi.
// Ce qui compte, ce sont les ÉCHECS — mauvaise clé, mauvais contexte, chiffré
// altéré — et le fait que deux chiffrements du même clair ne se ressemblent pas.
//
//   bun  run packages/shared/src/verify.ts
//   node packages/shared/src/verify.ts
import { randomBytes } from "node:crypto";
import {
  CryptoError,
  decryptSecret,
  encryptSecret,
  loadAppKey,
  safeEqual,
  secretContext,
} from "./crypto.ts";
import {
  envVarKeySchema,
  gitBranchSchema,
  serviceNameSchema,
} from "./validation.ts";

const runtime =
  typeof (globalThis as { Bun?: unknown }).Bun === "undefined"
    ? `Node ${process.version}`
    : `Bun ${(globalThis as { Bun: { version: string } }).Bun.version}`;

let pass = 0;
let fail = 0;
const ok = (m: string) => {
  pass += 1;
  console.log(`  [32m✓[0m ${m}`);
};
const ko = (m: string) => {
  fail += 1;
  console.log(`  [31m✗[0m ${m}`);
};

/** Attend un échec. Un test qui passe silencieusement est un test qui ment. */
function mustThrow(label: string, fn: () => unknown) {
  try {
    fn();
    ko(`${label} — AURAIT DÛ ÉCHOUER`);
  } catch (e) {
    if (e instanceof CryptoError) {
      ok(label);
    } else {
      ko(`${label} — mauvaise erreur : ${e instanceof Error ? e.message : e}`);
    }
  }
}

console.log(`\n[1m${runtime}[0m\n`);

const KEY = randomBytes(32);
const OTHER_KEY = randomBytes(32);
const ctx = secretContext.serverSshKey("srv-1");
const SECRET = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END-----";

// ── clé ─────────────────────────────────────────────────────────────────────
mustThrow("APP_KEY absente est refusée", () => loadAppKey(undefined));
mustThrow("APP_KEY trop courte est refusée", () =>
  loadAppKey(Buffer.from("court").toString("base64"))
);
if (loadAppKey(KEY.toString("base64")).equals(KEY)) {
  ok("APP_KEY valide est acceptée");
} else {
  ko("APP_KEY valide mal décodée");
}

// ── aller-retour ────────────────────────────────────────────────────────────
const box = encryptSecret(SECRET, KEY, ctx);
if (decryptSecret(box, KEY, ctx) === SECRET) {
  ok("aller-retour");
} else {
  ko("aller-retour incorrect");
}
if (box.includes("BEGIN")) {
  ko("le clair fuit dans le chiffré");
} else {
  ok("le clair n'apparaît pas dans le chiffré");
}

// ── non-déterminisme : IV unique à chaque chiffrement ───────────────────────
// Réutiliser un IV en GCM est catastrophique — ça casse l'authentification.
const boxes = new Set(
  Array.from({ length: 200 }, () => encryptSecret(SECRET, KEY, ctx))
);
if (boxes.size === 200) {
  ok("200 chiffrements du même clair → 200 résultats distincts");
} else {
  ko(`IV réutilisé : ${200 - boxes.size} collision(s)`);
}

// ── échecs attendus ─────────────────────────────────────────────────────────
mustThrow("mauvaise clé → refus", () => decryptSecret(box, OTHER_KEY, ctx));

mustThrow("mauvais contexte → refus (liaison AAD)", () =>
  decryptSecret(box, KEY, secretContext.serverSshKey("srv-2"))
);

mustThrow("chiffré déplacé vers un autre champ → refus", () =>
  decryptSecret(box, KEY, secretContext.envVar("srv-1"))
);

const parts = box.split(".");
const flip = (s: string) => {
  const b = Buffer.from(s, "base64url");
  const idx = b.length - 1;
  // biome-ignore lint/suspicious/noBitwiseOperators: altérer un bit EST le test
  b[idx] = (b[idx] ?? 0) ^ 0x01;
  return b.toString("base64url");
};
mustThrow("chiffré altéré → refus", () =>
  decryptSecret(
    [parts[0], parts[1], parts[2], flip(parts[3] ?? "")].join("."),
    KEY,
    ctx
  )
);
mustThrow("tag d'authentification altéré → refus", () =>
  decryptSecret(
    [parts[0], parts[1], flip(parts[2] ?? ""), parts[3]].join("."),
    KEY,
    ctx
  )
);
mustThrow("version inconnue → refus", () =>
  decryptSecret(["v2", parts[1], parts[2], parts[3]].join("."), KEY, ctx)
);
mustThrow("format malformé → refus", () => decryptSecret("nawak", KEY, ctx));

// ── comparaison à temps constant ────────────────────────────────────────────
if (
  safeEqual("token", "token") &&
  !safeEqual("token", "tokeX") &&
  !safeEqual("a", "ab")
) {
  ok("safeEqual");
} else {
  ko("safeEqual incorrect");
}

// ── validation ──────────────────────────────────────────────────────────────
const cases: [string, boolean][] = [
  ["api", true],
  ["-api", false],
  ["API", false],
  ["mon service", false],
];
if (
  cases.every(([v, want]) => serviceNameSchema.safeParse(v).success === want)
) {
  ok("serviceNameSchema accepte et refuse ce qu'il faut");
} else {
  ko("serviceNameSchema incohérent");
}

if (
  gitBranchSchema.safeParse("main").success &&
  !gitBranchSchema.safeParse("a..b").success &&
  !gitBranchSchema.safeParse("feat branch").success
) {
  ok("gitBranchSchema refuse les noms que git refuserait");
} else {
  ko("gitBranchSchema incohérent");
}

if (
  envVarKeySchema.safeParse("DATABASE_URL").success &&
  !envVarKeySchema.safeParse("1BAD").success &&
  !envVarKeySchema.safeParse("A-B").success
) {
  ok("envVarKeySchema impose un identifiant shell");
} else {
  ko("envVarKeySchema incohérent");
}

console.log(`\n[1m${runtime} — réussis ${pass}, échoués ${fail}[0m\n`);
process.exit(fail === 0 ? 0 : 1);
