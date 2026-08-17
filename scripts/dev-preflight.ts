// bun run scripts/dev-preflight.ts
//
// Everything `bun run dev` needs before a server can start, checked in the
// order a missing piece would bite. The sequence used to live in prose —
// `.claude/CLAUDE.md` and two shell-script headers — and one step, bringing
// up Postgres and Redis, had no command at all.
//
// Deploy targets are NOT checked: a Multipass VM is only needed to ship
// something (ADR-0016), and nobody should pay 2 GB of RAM to fix a form.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const RED = "\u001B[31m";
const GREEN = "\u001B[32m";
const DIM = "\u001B[2m";
const OFF = "\u001B[0m";

const problems: string[] = [];

function ok(message: string): void {
  process.stdout.write(`  ${GREEN}\u2713${OFF} ${message}\n`);
}

function missing(message: string): void {
  problems.push(message);
  process.stdout.write(`  ${RED}\u2717${OFF} ${message}\n`);
}

const docker = spawnSync(
  "docker",
  ["version", "--format", "{{.Server.Version}}"],
  { encoding: "utf-8" }
);
if (docker.status === 0) {
  ok(`docker ${docker.stdout.trim()}`);
} else {
  missing("docker is not running \u2014 the local stack needs it");
}

// Seeded rather than reported: the example is correct by construction, and
// `verify-compose` keeps the two files agreeing on APP_KEY and DATABASE_URL.
for (const app of ["web", "worker"]) {
  const env = join(ROOT, "apps", app, ".env");
  if (existsSync(env)) {
    ok(`apps/${app}/.env`);
  } else {
    copyFileSync(`${env}.example`, env);
    ok(`apps/${app}/.env ${DIM}created from .env.example${OFF}`);
  }
}

if (problems.length > 0) {
  process.stdout.write(
    `\n${RED}Cannot start.${OFF} Fix the above and run again.\n\n`
  );
  process.exit(1);
}
