import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface DevTarget {
  host: string;
  keyPath: string;
  privateKey: string;
  user: string;
}

const DEFAULT_VM = "noddle-target-1";

function multipassAddress(name: string): string {
  const listed = spawnSync("multipass", ["list", "--format", "csv"], {
    encoding: "utf-8",
  });
  if (listed.error || listed.status !== 0) {
    throw new Error(
      `multipass is not answering, so ${name}'s address cannot be resolved. ` +
        "Install it (https://multipass.run) or set TARGET_HOST to a reachable host."
    );
  }
  const row = listed.stdout
    .split("\n")
    .map((line) => line.split(","))
    .find((cells) => cells[0] === name);
  if (!row) {
    throw new Error(
      `no Multipass instance named ${name}. Create it with ./scripts/spike-local.sh`
    );
  }
  const [, state, ipv4] = row;
  if (state !== "Running") {
    throw new Error(
      `${name} exists but is ${state}. Start it with: multipass start ${name}`
    );
  }
  if (!ipv4) {
    throw new Error(
      `${name} is running but has no IPv4 lease yet. Give it a moment, or restart it.`
    );
  }
  return ipv4;
}

export function devTarget(name: string = DEFAULT_VM): DevTarget {
  const keyPath = process.env.SSH_KEY ?? join(homedir(), ".ssh", "id_ed25519");
  return {
    host: process.env.TARGET_HOST ?? multipassAddress(name),
    keyPath,
    privateKey: readFileSync(keyPath, "utf-8"),
    user: process.env.TARGET_USER ?? "ubuntu",
  };
}
