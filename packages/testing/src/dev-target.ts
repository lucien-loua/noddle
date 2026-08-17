/**
 * The local development target — the Multipass VM `spike-local.sh` creates.
 *
 * Its address used to be the literal `192.168.252.3`, written into 25 files.
 * Multipass hands out a new lease whenever the VM is recreated, so that
 * literal went stale without anything changing in the repo: measured on
 * 2026-08-17, the real VM was on .7 and every one of those 25 files pointed
 * at a machine that did not answer. The whole `vm` tier failed on an SSH
 * timeout, which reads as a broken executor rather than a stale constant.
 *
 * So the address is RESOLVED, never remembered, and a missing VM says so in
 * a sentence instead of timing out.
 *
 * This is a real target over real SSH (ADR-0016). Nothing here fakes one.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Structural copy of `ServerCredentials` from `@noddle/ssh-executor`. Not
 * imported: this package is a devDependency of ssh-executor's own verify, and
 * pointing back at it would close a cycle for a type of three fields.
 */
export interface DevTarget {
  host: string;
  /** The key's PATH, for the few places that shell out to `ssh -i`. */
  keyPath: string;
  privateKey: string;
  user: string;
}

const DEFAULT_VM = "noddle-target-1";

/** `multipass list --format csv`: Name,State,IPv4,… — one row per instance. */
function multipassAddress(name: string): string {
  const listed = spawnSync("multipass", ["list", "--format", "csv"], {
    encoding: "utf-8",
  });
  if (listed.error || listed.status !== 0) {
    throw new Error(
      `multipass is not answering, so ${name}'s address cannot be resolved. ` +
        "Install it (https://multipass.run) or set TARGET_HOST to a reachable host.",
    );
  }
  const row = listed.stdout
    .split("\n")
    .map((line) => line.split(","))
    .find((cells) => cells[0] === name);
  if (!row) {
    throw new Error(`no Multipass instance named ${name}. Create it with ./scripts/spike-local.sh`);
  }
  const [, state, ipv4] = row;
  if (state !== "Running") {
    throw new Error(`${name} exists but is ${state}. Start it with: multipass start ${name}`);
  }
  if (!ipv4) {
    throw new Error(
      `${name} is running but has no IPv4 lease yet. Give it a moment, or restart it.`,
    );
  }
  return ipv4;
}

/**
 * Credentials for a development target, ready for `connect()`.
 *
 * `TARGET_HOST` still wins, so the same suites can be pointed at a real VPS —
 * which is how the deploy chain gets proven on something that is not a laptop.
 */
export function devTarget(name: string = DEFAULT_VM): DevTarget {
  const keyPath = process.env.SSH_KEY ?? join(homedir(), ".ssh", "id_ed25519");
  return {
    host: process.env.TARGET_HOST ?? multipassAddress(name),
    keyPath,
    // Never logged, here or anywhere else.
    privateKey: readFileSync(keyPath, "utf-8"),
    user: process.env.TARGET_USER ?? "ubuntu",
  };
}
