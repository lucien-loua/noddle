#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const RUNNABLE = ["local", "pure", "vm"] as const;
const TIERS = [...RUNNABLE, "fixture"] as const;
type Tier = (typeof TIERS)[number];

const VERIFY_FILE = /^verify.*\.ts$/;
const DRIVERS = [
  "createDatabase(",
  "devStack(",
  "devTarget(",
  "dockerClient(",
] as const;
const TIER_HEADER = /^\/\/ tier: (local|pure|vm|fixture)\n/;
const RUNTIME_HEADER = /^\/\/ runtime: (bun|node)$/m;

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

const undeclared = all.filter((path) => !tierOf(path));
if (undeclared.length > 0) {
  for (const path of undeclared) {
    process.stderr.write(
      `${RED}✗${OFF} ${relative(cwd, path)} has no \`// tier:\` header\n`
    );
  }
  process.exit(2);
}

const dishonest = all
  .filter((path) => tierOf(path) === "pure")
  .flatMap((path) => {
    const src = readFileSync(path, "utf-8");
    const driver = DRIVERS.find((name) => src.includes(name));
    return driver ? [{ driver, path }] : [];
  });
if (dishonest.length > 0) {
  for (const { driver, path } of dishonest) {
    process.stderr.write(
      `${RED}✗${OFF} ${relative(cwd, path)} declares \`// tier: pure\` but reaches for \`${driver}\`\n`
    );
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
  const runtime =
    readFileSync(path, "utf-8").match(RUNTIME_HEADER)?.[1] ?? RUNTIME[tier];
  process.stdout.write(`\n${BOLD}${name}${OFF} ${DIM}(${runtime})${OFF}\n`);
  const started = Date.now();
  const { signal, status } = spawnSync(runtime, [path], {
    killSignal: "SIGKILL",
    stdio: "inherit",
    timeout: SUITE_TIMEOUT_MS,
  });
  if (signal) {
    const minutes = Math.round((Date.now() - started) / 60_000);
    process.stdout.write(
      `\n  ${RED}✗ timed out after ${minutes}m${OFF} — killed, the tier continues\n`
    );
    timedOut.push(name);
    failures.push(name);
  } else if (status !== 0) {
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
  const why = timedOut.includes(name) ? ` ${DIM}(timed out)${OFF}` : "";
  process.stdout.write(`  ${RED}✗${OFF} ${name}${why}\n`);
}
process.exit(1);
