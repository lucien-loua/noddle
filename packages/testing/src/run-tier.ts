#!/usr/bin/env bun
// noddle-verify <pure|local|vm>
//
// Runs the verify suites of ONE package — the one this is invoked from. Turbo
// runs it across packages, which is where the parallelism comes from; here
// everything is sequential on purpose, because within a package the local and
// vm suites share a database and a VM.
//
// The tier is DECLARED, on the first line of each suite: `// tier: pure`.
// Derivation from the source was tried and abandoned — it misread three suites
// out of sixty-eight, and always in the direction that hides the mistake. A
// declaration can be wrong too, but the pure tier runs with NOTHING started, so
// a suite wrongly marked `pure` fails on its first run instead of quietly
// changing what CI covers.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const RUNNABLE = ["local", "pure", "vm"] as const;
/** `fixture` is a module other suites import, never a suite itself. */
const TIERS = [...RUNNABLE, "fixture"] as const;
type Tier = (typeof TIERS)[number];

const VERIFY_FILE = /^verify.*\.ts$/;
const TIER_HEADER = /^\/\/ tier: (local|pure|vm|fixture)\n/;

/**
 * `vm` runs on Node: `dockerode` over the SSH tunnel does not work on Bun
 * (ADR-0015). Re-checking that on both runtimes stays a deliberate manual act.
 */
type Runnable = (typeof RUNNABLE)[number];
const RUNTIME: Record<Runnable, string> = {
  local: "bun",
  pure: "bun",
  vm: "node",
};

const RED = "\u001B[31m";
const GREEN = "\u001B[32m";
const BOLD = "\u001B[1m";
const OFF = "\u001B[0m";

function walk(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) {
      continue;
    }
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(path, found);
    } else if (VERIFY_FILE.test(entry.name)) {
      found.push(path);
    }
  }
  return found;
}

function tierOf(path: string): Tier | undefined {
  return readFileSync(path, "utf-8").match(TIER_HEADER)?.[1] as
    | Tier
    | undefined;
}

const requested = process.argv.at(2);
if (!(requested && (RUNNABLE as readonly string[]).includes(requested))) {
  process.stderr.write(`usage: noddle-verify <${RUNNABLE.join("|")}>\n`);
  process.exit(2);
}
const tier = requested as Runnable;

const cwd = process.cwd();
const all = walk(cwd).toSorted();

// A suite with no header is not silently skipped: it would drop out of every
// tier at once, which is exactly the failure this replaced.
const undeclared = all.filter((path) => !tierOf(path));
if (undeclared.length > 0) {
  for (const path of undeclared) {
    process.stderr.write(
      `${RED}✗${OFF} ${relative(cwd, path)} has no \`// tier:\` header\n`
    );
  }
  process.exit(2);
}

const suites = all.filter((path) => tierOf(path) === tier);
if (suites.length === 0) {
  process.exit(0);
}

const failures: string[] = [];
for (const path of suites) {
  const name = relative(cwd, path);
  process.stdout.write(`\n${BOLD}${name}${OFF}\n`);
  const { status } = spawnSync(RUNTIME[tier], [path], { stdio: "inherit" });
  if (status !== 0) {
    failures.push(name);
  }
}

if (failures.length === 0) {
  process.stdout.write(
    `\n${GREEN}${BOLD}${tier}: ${suites.length} suites passed${OFF}\n`
  );
  process.exit(0);
}
process.stdout.write(
  `\n${RED}${BOLD}${tier}: ${failures.length} of ${suites.length} suites failed${OFF}\n`
);
for (const name of failures) {
  process.stdout.write(`  ${RED}✗${OFF} ${name}\n`);
}
process.exit(1);
