import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readdirSync } from "node:fs";
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
  {
    encoding: "utf-8",
  }
);
if (docker.status === 0) {
  ok(`docker ${docker.stdout.trim()}`);
} else {
  missing("docker is not running \u2014 the local stack needs it");
}

const apps = readdirSync(join(ROOT, "apps"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .toSorted();

for (const app of apps) {
  const env = join(ROOT, "apps", app, ".env");
  const example = `${env}.example`;
  if (existsSync(env)) {
    ok(`apps/${app}/.env`);
  } else if (existsSync(example)) {
    copyFileSync(example, env);
    ok(`apps/${app}/.env ${DIM}created from .env.example${OFF}`);
  } else {
    missing(`apps/${app} has neither .env nor .env.example`);
  }
}

if (problems.length > 0) {
  process.stdout.write(
    `\n${RED}Cannot start.${OFF} Fix the above and run again.\n\n`
  );
  process.exit(1);
}
