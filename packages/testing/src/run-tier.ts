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
/** Optional second line. Overrides the tier default when a suite needs the other runtime. */
const RUNTIME_HEADER = /^\/\/ runtime: (bun|node)$/m;

/**
 * The tier's DEFAULT runtime — `vm` on Node because `dockerode` over the SSH
 * tunnel does not work on Bun (ADR-0015).
 *
 * A default, not a rule: the runtime is a property of the SUITE, not of the
 * tier. Measured — verify-live and verify-webhook are `vm` suites that
 * orchestrate processes with `Bun.spawn` and die on Node with
 * `Bun is not defined`, while ssh-executor's suite only *detects* the runtime
 * and genuinely needs Node for dockerode. A suite says so with a second
 * header line: `// runtime: bun`.
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
const DIM = "\u001B[2m";

/**
 * One value for every suite, deliberately not declarable per file.
 *
 * A suite CAN hang: verify-volume-restore sat for 30 minutes at 0% CPU with
 * the VM idle and S3 answering — it holds no timeout of its own, and neither
 * does any of the other 23. One hang stalls the whole tier, and in CI it
 * would spend the job's entire budget without producing a single diagnostic.
 * Killing it by hand is what destroyed the results of five suites that had
 * already run.
 *
 * 15 minutes is far above anything measured — the longest legitimate suite,
 * verify-lifecycle, does a full Railpack build in a few. If one ever needs
 * more for a good reason, that day there will be two cases and the seam will
 * be real. Not before.
 */
const SUITE_TIMEOUT_MS = 15 * 60 * 1000;
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
  return readFileSync(path, "utf-8").match(TIER_HEADER)?.[1] as Tier | undefined;
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
    process.stderr.write(`${RED}✗${OFF} ${relative(cwd, path)} has no \`// tier:\` header\n`);
  }
  process.exit(2);
}

const suites = all.filter((path) => tierOf(path) === tier);
if (suites.length === 0) {
  process.exit(0);
}

const failures: string[] = [];
const timedOut: string[] = [];
for (const path of suites) {
  const name = relative(cwd, path);
  const runtime = readFileSync(path, "utf-8").match(RUNTIME_HEADER)?.[1] ?? RUNTIME[tier];
  process.stdout.write(`\n${BOLD}${name}${OFF} ${DIM}(${runtime})${OFF}\n`);
  const started = Date.now();
  const { signal, status } = spawnSync(runtime, [path], {
    killSignal: "SIGKILL",
    stdio: "inherit",
    timeout: SUITE_TIMEOUT_MS,
  });
  // A timeout kills the child, so there is no exit code — only a signal.
  // Named as such rather than reported as a plain failure: "it hung" and
  // "it asserted false" call for entirely different next steps.
  if (signal) {
    const minutes = Math.round((Date.now() - started) / 60_000);
    process.stdout.write(
      `\n  ${RED}✗ timed out after ${minutes}m${OFF} — killed, the tier continues\n`,
    );
    timedOut.push(name);
    failures.push(name);
  } else if (status !== 0) {
    failures.push(name);
  }
}

if (failures.length === 0) {
  process.stdout.write(`\n${GREEN}${BOLD}${tier}: ${suites.length} suites passed${OFF}\n`);
  process.exit(0);
}
process.stdout.write(
  `\n${RED}${BOLD}${tier}: ${failures.length} of ${suites.length} suites failed${OFF}\n`,
);
for (const name of failures) {
  const why = timedOut.includes(name) ? ` ${DIM}(timed out)${OFF}` : "";
  process.stdout.write(`  ${RED}✗${OFF} ${name}${why}\n`);
}
process.exit(1);
