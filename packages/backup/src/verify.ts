// bun run packages/backup/src/verify.ts
// node packages/backup/src/verify.ts
import { BACKUP_EXTENSION, buildBackupInsert, pickDestination } from "#index";

const runtime =
  typeof globalThis.Bun === "undefined"
    ? `Node ${process.version}`
    : `Bun ${globalThis.Bun.version}`;

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

console.log(`\n\x1b[1m${runtime} — backup domain\x1b[0m`);

const a = { id: "a", prefix: "dest-a" };
const b = { id: "b", prefix: "dest-b" };

try {
  pickDestination([], null);
  ko("zero destinations: accepted when it should refuse");
} catch (e) {
  const m = e instanceof Error ? e.message : String(e);
  if (m.includes("no S3 destination configured")) {
    ok("zero destinations: refused with a clear message");
  } else {
    ko(`refused, but for the wrong reason: ${m}`);
  }
}

const single = pickDestination([a], null);
if (single.id === "a") {
  ok("single destination: returned without needing to choose");
} else {
  ko(`single destination: returned ${single.id}`);
}

try {
  pickDestination([a, b], null);
  ko("two destinations, no choice: accepted when it should refuse");
} catch (e) {
  const m = e instanceof Error ? e.message : String(e);
  if (m.includes("several S3 destinations")) {
    ok("two destinations, no choice: refused explicitly");
  } else {
    ko(`refused, but for the wrong reason: ${m}`);
  }
}

const chosen = pickDestination([a, b], "b");
if (chosen.id === "b") {
  ok("two destinations, explicit choice: returns the REQUESTED one");
} else {
  ko(`explicit choice: returned ${chosen.id}`);
}

try {
  pickDestination([a, b], "absent");
  ko("an id absent from the candidates is accepted");
} catch (e) {
  const m = e instanceof Error ? e.message : String(e);
  if (m.includes("no longer exists")) {
    ok("an id absent from the candidates is refused with a clear message");
  } else {
    ko(`refused, but for the wrong reason: ${m}`);
  }
}

const ENGINES = ["postgres", "mysql", "mariadb", "mongo", "redis"] as const;
const missing = ENGINES.filter((e) => !(e in BACKUP_EXTENSION));
if (missing.length === 0) {
  ok("BACKUP_EXTENSION covers all five engines");
} else {
  ko(`BACKUP_EXTENSION incomplete: ${missing.join(", ")}`);
}

if (
  BACKUP_EXTENSION.postgres === "dump" &&
  BACKUP_EXTENSION.redis === "rdb" &&
  BACKUP_EXTENSION.mysql !== "rdb" &&
  BACKUP_EXTENSION.mariadb !== "rdb"
) {
  ok(
    "mysql/mariadb do not inherit the rdb extension from the original ternary"
  );
} else {
  ko("an extension does not match its engine's real dumper");
}

const takenAt = new Date("2026-08-10T12:00:00.000Z");
const insertA = buildBackupInsert({
  database: { engine: "mysql", id: "db-1", name: "shop" },
  kind: "manual",
  resolved: a,
  takenAt,
});
if (
  insertA.destinationId === "a" &&
  insertA.objectKey.startsWith("dest-a/shop/") &&
  insertA.objectKey.endsWith(".sql")
) {
  ok("buildBackupInsert aligns destinationId and the prefix IN the key");
} else {
  ko(`buildBackupInsert inconsistent: ${JSON.stringify(insertA)}`);
}

const insertB = buildBackupInsert({
  database: { engine: "postgres", id: "db-2", name: "shop" },
  kind: "scheduled",
  resolved: b,
  takenAt,
});
if (insertB.destinationId === "b" && insertB.objectKey.startsWith("dest-b/")) {
  ok("destinationId and prefix stay aligned for a second destination");
} else {
  ko(`destination/prefix mismatch: ${JSON.stringify(insertB)}`);
}

console.log(`\n\x1b[1m${runtime} — passed ${pass}, failed ${fail}\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
